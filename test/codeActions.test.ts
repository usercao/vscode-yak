import type { CodeAction as CssCodeAction, Range as CssRange } from 'vscode-css-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { describe, expect, it } from 'vitest'
import { mapVirtualCssCodeAction } from '../src/codeActions'
import type { VirtualCssDocument } from '../src/hover'
import { createVirtualCssText, findTemplate, type Template } from '../src/template'

function styledSource(css: string): string {
  return [
    "import { styled } from 'yak'",
    'const Panel = styled.div`',
    `  ${css}`,
    '`',
  ].join('\n')
}

function createTemplate(source: string, needle: string): Template {
  const template = findTemplate(source, source.indexOf(needle), 'typescriptreact', '/fixture.tsx')

  if (!template) {
    throw new Error(`Expected template at ${needle}`)
  }

  return template
}

function createVirtualDocument(template: Template): VirtualCssDocument {
  const virtualCssText = createVirtualCssText(template)

  return {
    document: TextDocument.create('yak:test', 'css', 1, virtualCssText.text),
    prefixLength: virtualCssText.prefixLength,
    sourceLength: template.maskedBody.length,
    sourceStart: template.bodyStart,
  }
}

function rangeAtOffsets(virtualCss: VirtualCssDocument, start: number, end: number): CssRange {
  return {
    start: virtualCss.document.positionAt(start),
    end: virtualCss.document.positionAt(end),
  }
}

function codeAction(virtualCss: VirtualCssDocument, ranges: readonly { newText: string; range: CssRange }[]): CssCodeAction {
  return {
    edit: {
      documentChanges: [{
        edits: [...ranges],
        textDocument: {
          uri: virtualCss.document.uri,
          version: virtualCss.document.version,
        },
      }],
    },
    kind: 'quickfix',
    title: "Rename to 'color'",
  }
}

describe('yak CSS code actions', () => {
  it('maps a single-line virtual CSS replacement back to the host template', () => {
    const source = styledSource('colro: red;')
    const template = createTemplate(source, 'colro')
    const virtualCss = createVirtualDocument(template)
    const start = virtualCss.prefixLength + template.maskedBody.indexOf('colro')
    const action = mapVirtualCssCodeAction(
      codeAction(virtualCss, [{ newText: 'color', range: rangeAtOffsets(virtualCss, start, start + 5) }]),
      template,
      virtualCss,
    )

    expect(action).toMatchObject({ kind: 'quickfix', title: "Rename to 'color'" })
    expect(action?.edits).toHaveLength(1)
    expect(source.slice(action?.edits[0].range.start, action?.edits[0].range.end)).toBe('colro')
    expect(action?.edits[0].newText).toBe('color')
  })

  it('maps multiple non-overlapping edits in the same virtual document', () => {
    const source = styledSource('colro: red;\n  bakground: blue;')
    const template = createTemplate(source, 'colro')
    const virtualCss = createVirtualDocument(template)
    const colroStart = virtualCss.prefixLength + template.maskedBody.indexOf('colro')
    const bakgroundStart = virtualCss.prefixLength + template.maskedBody.indexOf('bakground')
    const action = mapVirtualCssCodeAction(
      codeAction(virtualCss, [
        { newText: 'color', range: rangeAtOffsets(virtualCss, colroStart, colroStart + 5) },
        { newText: 'background', range: rangeAtOffsets(virtualCss, bakgroundStart, bakgroundStart + 9) },
      ]),
      template,
      virtualCss,
    )

    expect(action?.edits.map((edit) => source.slice(edit.range.start, edit.range.end))).toEqual(['colro', 'bakground'])
  })

  it('rejects edits that touch wrappers, interpolations, other documents, multiline ranges, or commands', () => {
    const source = styledSource('color: ${theme.accent};\n  colro: red;')
    const template = createTemplate(source, 'colro')
    const virtualCss = createVirtualDocument(template)
    const interpolation = template.interpolations[0]
    const colroStart = virtualCss.prefixLength + template.maskedBody.indexOf('colro')
    const valid = { newText: 'color', range: rangeAtOffsets(virtualCss, colroStart, colroStart + 5) }
    const invalidActions: CssCodeAction[] = [
      codeAction(virtualCss, [{ newText: 'x', range: rangeAtOffsets(virtualCss, virtualCss.prefixLength - 1, virtualCss.prefixLength) }]),
      codeAction(virtualCss, [{
        newText: 'x',
        range: rangeAtOffsets(
          virtualCss,
          virtualCss.prefixLength + interpolation.start,
          virtualCss.prefixLength + interpolation.end,
        ),
      }]),
      codeAction(virtualCss, [{
        newText: 'x',
        range: rangeAtOffsets(
          virtualCss,
          virtualCss.prefixLength + template.maskedBody.length,
          virtualCss.prefixLength + template.maskedBody.length + 1,
        ),
      }]),
      codeAction(virtualCss, [{
        newText: 'color',
        range: rangeAtOffsets(virtualCss, colroStart, virtualCss.document.getText().indexOf('\n', colroStart + 5) + 1),
      }]),
      codeAction(virtualCss, [{ newText: 'color\n', range: rangeAtOffsets(virtualCss, colroStart, colroStart + 5) }]),
      {
        ...codeAction(virtualCss, [valid]),
        edit: {
          documentChanges: [{
            edits: [valid],
            textDocument: { uri: 'yak:other', version: virtualCss.document.version },
          }],
        },
      },
      {
        ...codeAction(virtualCss, [valid]),
        command: { command: 'unsafe', title: 'unsafe' },
      },
    ]

    for (const action of invalidActions) {
      expect(mapVirtualCssCodeAction(action, template, virtualCss)).toBeUndefined()
    }
  })

  it('rejects overlapping edits and accepts only the current virtual document', () => {
    const source = styledSource('colro: red;')
    const template = createTemplate(source, 'colro')
    const virtualCss = createVirtualDocument(template)
    const start = virtualCss.prefixLength + template.maskedBody.indexOf('colro')
    const action = codeAction(virtualCss, [
      { newText: 'color', range: rangeAtOffsets(virtualCss, start, start + 5) },
      { newText: 'x', range: rangeAtOffsets(virtualCss, start + 2, start + 5) },
    ])

    expect(mapVirtualCssCodeAction(action, template, virtualCss)).toBeUndefined()
  })
})
