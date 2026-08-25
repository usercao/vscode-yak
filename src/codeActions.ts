import type {
  CodeAction as CssCodeAction,
  Range as CssRange,
  TextEdit as CssTextEdit,
  WorkspaceEdit as CssWorkspaceEdit,
} from 'vscode-css-languageservice'

import { mapVirtualCssRangeToTemplateOffsets } from './diagnostics'
import type { VirtualCssDocument } from './hover'
import type { Template, OffsetRange } from './template'

export interface MappedCssTextEdit {
  newText: string
  range: OffsetRange
}

export interface MappedCssCodeAction {
  edits: readonly MappedCssTextEdit[]
  isPreferred?: boolean
  kind?: string
  title: string
}

export function mapVirtualCssCodeAction(
  action: CssCodeAction,
  template: Template,
  virtualCss: VirtualCssDocument,
): MappedCssCodeAction | undefined {
  if (!action.edit || action.command) {
    return undefined
  }

  const edits = getVirtualTextEdits(action.edit, virtualCss)

  if (!edits) {
    return undefined
  }

  const mappedEdits = edits.flatMap((edit) => {
    const mappedEdit = mapVirtualCssTextEdit(edit, template, virtualCss)

    return mappedEdit ? [mappedEdit] : []
  })

  if (mappedEdits.length !== edits.length || hasOverlappingEdits(mappedEdits)) {
    return undefined
  }

  return {
    edits: mappedEdits,
    isPreferred: action.isPreferred,
    kind: action.kind,
    title: action.title,
  }
}

function getVirtualTextEdits(
  workspaceEdit: CssWorkspaceEdit,
  virtualCss: VirtualCssDocument,
): readonly CssTextEdit[] | undefined {
  if (workspaceEdit.documentChanges) {
    if (workspaceEdit.changes || workspaceEdit.documentChanges.length === 0) {
      return undefined
    }

    const edits: CssTextEdit[] = []

    for (const change of workspaceEdit.documentChanges) {
      if (!isVirtualTextDocumentEdit(change, virtualCss)) {
        return undefined
      }

      edits.push(...change.edits)
    }

    return edits
  }

  if (!workspaceEdit.changes) {
    return undefined
  }

  const entries = Object.entries(workspaceEdit.changes)

  if (entries.length !== 1 || entries[0][0] !== virtualCss.document.uri) {
    return undefined
  }

  return entries[0][1]
}

function isVirtualTextDocumentEdit(
  change: unknown,
  virtualCss: VirtualCssDocument,
): change is { edits: CssTextEdit[]; textDocument: { uri: string; version: number } } {
  if (
    !change ||
    typeof change !== 'object' ||
    !('edits' in change) ||
    !('textDocument' in change)
  ) {
    return false
  }

  const textDocumentEdit = change as {
    edits?: unknown
    textDocument?: { uri?: unknown; version?: unknown }
  }

  return (
    Array.isArray(textDocumentEdit.edits) &&
    textDocumentEdit.textDocument?.uri === virtualCss.document.uri &&
    textDocumentEdit.textDocument.version === virtualCss.document.version
  )
}

function mapVirtualCssTextEdit(
  edit: CssTextEdit,
  template: Template,
  virtualCss: VirtualCssDocument,
): MappedCssTextEdit | undefined {
  if (
    !isValidVirtualRange(edit.range, virtualCss) ||
    edit.range.start.line !== edit.range.end.line ||
    /[\r\n]/.test(edit.newText)
  ) {
    return undefined
  }

  const range = mapVirtualCssRangeToTemplateOffsets(edit.range, template, virtualCss)

  return range ? { newText: edit.newText, range } : undefined
}

function isValidVirtualRange(range: CssRange, virtualCss: VirtualCssDocument) {
  const start = virtualCss.document.offsetAt(range.start)
  const end = virtualCss.document.offsetAt(range.end)

  return (
    start < end &&
    isExactVirtualPosition(range.start, start, virtualCss) &&
    isExactVirtualPosition(range.end, end, virtualCss)
  )
}

function isExactVirtualPosition(
  position: CssRange['start'],
  offset: number,
  virtualCss: VirtualCssDocument,
) {
  const normalized = virtualCss.document.positionAt(offset)

  return normalized.line === position.line && normalized.character === position.character
}

function hasOverlappingEdits(edits: readonly MappedCssTextEdit[]) {
  const ordered = [...edits].sort((left, right) => left.range.start - right.range.start)

  return ordered.some((edit, index) => index > 0 && ordered[index - 1].range.end > edit.range.start)
}
