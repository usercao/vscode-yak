import * as vscode from 'vscode'
import {
  getCSSLanguageService,
  type CompletionItem as CssCompletionItem,
  type Range as CssRange,
} from 'vscode-css-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'

const cssLanguageService = getCSSLanguageService()
const nextYakDocumentSelector: vscode.DocumentSelector = [
  { language: 'javascript' },
  { language: 'javascriptreact' },
  { language: 'typescript' },
  { language: 'typescriptreact' },
]
const cssCompletionTriggerCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:-@'.split('')
const taggedTemplatePattern =
  /\b(styled(?:\s*\.\s*[$A-Z_a-z][$\w]*|\s*\([^`()]*\))|css|globalStyle|keyframes)\s*`/g

interface OffsetRange {
  start: number
  end: number
}

interface NextYakTemplate {
  bodyEnd: number
  bodyStart: number
  interpolations: readonly OffsetRange[]
  maskedBody: string
  tag: string
}

interface VirtualCssDocument {
  document: TextDocument
  prefixLength: number
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      nextYakDocumentSelector,
      new NextYakCssCompletionProvider(),
      ...cssCompletionTriggerCharacters,
    ),
  )
}

class NextYakCssCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.CompletionList | undefined {
    if (token.isCancellationRequested) {
      return undefined
    }

    const source = document.getText()
    const cursorOffset = document.offsetAt(position)
    const template = findNextYakTemplate(source, cursorOffset)

    if (!template) {
      return undefined
    }

    const virtualCss = createVirtualCssDocument(document, template)
    const virtualOffset = virtualCss.prefixLength + cursorOffset - template.bodyStart
    const stylesheet = cssLanguageService.parseStylesheet(virtualCss.document)
    const completions = cssLanguageService.doComplete(
      virtualCss.document,
      virtualCss.document.positionAt(virtualOffset),
      stylesheet,
    )

    if (token.isCancellationRequested) {
      return undefined
    }

    const items = completions.items.flatMap((item) => {
      const completion = toCompletionItem(item, document, template, virtualCss)
      return completion ? [completion] : []
    })

    return new vscode.CompletionList(items, completions.isIncomplete)
  }
}

function findNextYakTemplate(source: string, cursorOffset: number): NextYakTemplate | undefined {
  taggedTemplatePattern.lastIndex = 0

  for (let match = taggedTemplatePattern.exec(source); match; match = taggedTemplatePattern.exec(source)) {
    const tag = match[1]
    const templateStart = match.index + match[0].lastIndexOf('`')
    const bodyStart = templateStart + 1
    const parsedTemplate = scanTemplate(source, bodyStart)

    if (cursorOffset >= bodyStart && cursorOffset <= parsedTemplate.bodyEnd) {
      const cursorInBody = cursorOffset - bodyStart

      if (parsedTemplate.interpolations.some((range) => isOffsetInRange(cursorInBody, range))) {
        return undefined
      }

      return {
        bodyStart,
        bodyEnd: parsedTemplate.bodyEnd,
        interpolations: parsedTemplate.interpolations,
        maskedBody: maskInterpolations(
          source.slice(bodyStart, parsedTemplate.bodyEnd),
          parsedTemplate.interpolations,
        ),
        tag,
      }
    }

    if (parsedTemplate.bodyEnd >= source.length) {
      return undefined
    }

    taggedTemplatePattern.lastIndex = parsedTemplate.bodyEnd + 1
  }

  return undefined
}

function scanTemplate(source: string, bodyStart: number) {
  const interpolations: OffsetRange[] = []
  let offset = bodyStart

  while (offset < source.length) {
    const character = source[offset]

    if (character === '\\') {
      offset += 2
      continue
    }

    if (character === '`') {
      return { bodyEnd: offset, interpolations }
    }

    if (character === '$' && source[offset + 1] === '{') {
      const interpolationEnd = findInterpolationEnd(source, offset + 2)
      const rangeEnd = interpolationEnd ?? source.length

      interpolations.push({ start: offset - bodyStart, end: rangeEnd - bodyStart })

      if (!interpolationEnd) {
        return { bodyEnd: source.length, interpolations }
      }

      offset = interpolationEnd
      continue
    }

    offset += 1
  }

  return { bodyEnd: source.length, interpolations }
}

function findInterpolationEnd(source: string, start: number): number | undefined {
  let braceDepth = 1
  let offset = start

  while (offset < source.length) {
    const character = source[offset]

    if (character === "'" || character === '"') {
      offset = skipQuotedString(source, offset, character)
      continue
    }

    if (character === '`') {
      offset = skipTemplateLiteral(source, offset)
      continue
    }

    if (character === '/' && source[offset + 1] === '/') {
      offset = skipLineComment(source, offset)
      continue
    }

    if (character === '/' && source[offset + 1] === '*') {
      offset = skipBlockComment(source, offset)
      continue
    }

    if (character === '{') {
      braceDepth += 1
    } else if (character === '}') {
      braceDepth -= 1

      if (braceDepth === 0) {
        return offset + 1
      }
    }

    offset += 1
  }

  return undefined
}

function skipQuotedString(source: string, start: number, quote: string): number {
  let offset = start + 1

  while (offset < source.length) {
    if (source[offset] === '\\') {
      offset += 2
    } else if (source[offset] === quote) {
      return offset + 1
    } else {
      offset += 1
    }
  }

  return source.length
}

function skipTemplateLiteral(source: string, start: number): number {
  let offset = start + 1

  while (offset < source.length) {
    if (source[offset] === '\\') {
      offset += 2
    } else if (source[offset] === '`') {
      return offset + 1
    } else if (source[offset] === '$' && source[offset + 1] === '{') {
      offset = findInterpolationEnd(source, offset + 2) ?? source.length
    } else {
      offset += 1
    }
  }

  return source.length
}

function skipLineComment(source: string, start: number): number {
  const lineEnd = source.indexOf('\n', start + 2)
  return lineEnd === -1 ? source.length : lineEnd + 1
}

function skipBlockComment(source: string, start: number): number {
  const commentEnd = source.indexOf('*/', start + 2)
  return commentEnd === -1 ? source.length : commentEnd + 2
}

function isOffsetInRange(offset: number, range: OffsetRange) {
  return offset >= range.start && offset < range.end
}

function maskInterpolations(templateBody: string, interpolations: readonly OffsetRange[]) {
  let maskedBody = ''
  let offset = 0

  for (const interpolation of interpolations) {
    maskedBody += templateBody.slice(offset, interpolation.start)
    maskedBody += templateBody.slice(interpolation.start, interpolation.end).replace(/[^\r\n]/g, ' ')
    offset = interpolation.end
  }

  return maskedBody + templateBody.slice(offset)
}

function createVirtualCssDocument(
  document: vscode.TextDocument,
  template: NextYakTemplate,
): VirtualCssDocument {
  const prefix = template.tag === 'keyframes' ? '@keyframes next_yak_completion {\n' : ':root {\n'
  const text = `${prefix}${template.maskedBody}\n}`

  return {
    document: TextDocument.create(
      `next-yak:${document.uri.toString()}?start=${template.bodyStart}`,
      'css',
      document.version,
      text,
    ),
    prefixLength: prefix.length,
  }
}

function toCompletionItem(
  item: CssCompletionItem,
  document: vscode.TextDocument,
  template: NextYakTemplate,
  virtualCss: VirtualCssDocument,
): vscode.CompletionItem | undefined {
  const completion = new vscode.CompletionItem(
    item.label,
    item.kind ? (item.kind as vscode.CompletionItemKind) : vscode.CompletionItemKind.Property,
  )
  const textEdit = getTextEdit(item)

  if (textEdit) {
    const range = toDocumentRange(textEdit.range, document, template, virtualCss)

    if (!range) {
      return undefined
    }

    completion.range = range
    completion.insertText = toInsertText(textEdit.newText, item.insertTextFormat)
  } else if (item.insertText) {
    completion.insertText = toInsertText(item.insertText, item.insertTextFormat)
  }

  completion.detail = item.detail
  completion.documentation = toDocumentation(item.documentation)
  completion.filterText = item.filterText
  completion.preselect = item.preselect
  completion.sortText = item.sortText

  if (item.tags?.includes(1)) {
    completion.tags = [vscode.CompletionItemTag.Deprecated]
  }

  return completion
}

function getTextEdit(item: CssCompletionItem): { newText: string; range: CssRange } | undefined {
  const textEdit = item.textEdit

  if (!textEdit || !('range' in textEdit) || !('newText' in textEdit)) {
    return undefined
  }

  return textEdit
}

function toDocumentRange(
  range: CssRange,
  document: vscode.TextDocument,
  template: NextYakTemplate,
  virtualCss: VirtualCssDocument,
): vscode.Range | undefined {
  const start = virtualCss.document.offsetAt(range.start) - virtualCss.prefixLength
  const end = virtualCss.document.offsetAt(range.end) - virtualCss.prefixLength

  if (start < 0 || end < start || end > template.maskedBody.length) {
    return undefined
  }

  return new vscode.Range(
    document.positionAt(template.bodyStart + start),
    document.positionAt(template.bodyStart + end),
  )
}

function toInsertText(text: string, format: number | undefined) {
  return format === 2 ? new vscode.SnippetString(text) : text
}

function toDocumentation(documentation: CssCompletionItem['documentation']) {
  if (!documentation) {
    return undefined
  }

  if (typeof documentation === 'string') {
    return documentation
  }

  return new vscode.MarkdownString(documentation.value)
}
