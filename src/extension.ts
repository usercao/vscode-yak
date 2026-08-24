import * as vscode from 'vscode'
import {
  getDefaultCSSDataProvider,
  getCSSLanguageService,
  type CompletionItem as CssCompletionItem,
  type Range as CssRange,
} from 'vscode-css-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  createVirtualCssText,
  findNextYakTemplate,
  getSelectorCompletionContext,
  mapVirtualRangeToSourceOffsets,
  type NextYakTemplate,
  type SelectorCompletionContext,
} from './nextYakTemplate'

const cssLanguageService = getCSSLanguageService()
const cssPropertyNames = new Set(
  getDefaultCSSDataProvider().provideProperties().map((property) => property.name),
)
const nextYakDocumentSelector: vscode.DocumentSelector = [
  { language: 'javascript' },
  { language: 'javascriptreact' },
  { language: 'typescript' },
  { language: 'typescriptreact' },
]
const cssCompletionTriggerCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:-@'.split('')

interface VirtualCssDocument {
  document: TextDocument
  prefixLength: number
  sourceLength: number
  sourceStart: number
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

export class NextYakCssCompletionProvider implements vscode.CompletionItemProvider {
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
    const template = findNextYakTemplate(source, cursorOffset, document.languageId, document.fileName)

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

    const selectorContext = getSelectorCompletionContext(source, cursorOffset, template)
    const usesSelectorFallback = selectorContext && isSelectorCompletionContext(selectorContext)
    const items = completions.items
      .filter((item) => !usesSelectorFallback || !item.label.startsWith(':'))
      .flatMap((item) => {
        const completion = toCompletionItem(item, document, virtualCss)
        return completion ? [completion] : []
      })
    const existingLabels = new Set(items.map((item) => typeof item.label === 'string' ? item.label : item.label.label))
    const selectorItems = getSelectorCompletionItems(
      source,
      cursorOffset,
      document,
      template,
      existingLabels,
    )

    return new vscode.CompletionList([...items, ...selectorItems], true)
  }
}

function createVirtualCssDocument(
  document: vscode.TextDocument,
  template: NextYakTemplate,
): VirtualCssDocument {
  const virtualCssText = createVirtualCssText(template)

  return {
    document: TextDocument.create(
      `next-yak:${document.uri.toString()}?start=${template.bodyStart}`,
      'css',
      document.version,
      virtualCssText.text,
    ),
    prefixLength: virtualCssText.prefixLength,
    sourceLength: template.maskedBody.length,
    sourceStart: template.bodyStart,
  }
}

function getSelectorCompletionItems(
  source: string,
  cursorOffset: number,
  document: vscode.TextDocument,
  template: NextYakTemplate,
  existingLabels: ReadonlySet<string>,
) {
  const selectorContext = getSelectorCompletionContext(source, cursorOffset, template)

  if (!selectorContext || !isSelectorCompletionContext(selectorContext)) {
    return []
  }

  const selectorDocument = createSelectorDocument(document, selectorContext)
  const stylesheet = cssLanguageService.parseStylesheet(selectorDocument.document)
  const completions = cssLanguageService.doComplete(
    selectorDocument.document,
    selectorDocument.document.positionAt(selectorContext.text.length),
    stylesheet,
  )

  return completions.items
    .filter((item) => item.label.startsWith(':') && !existingLabels.has(item.label))
    .flatMap((item) => {
      const completion = toSelectorCompletionItem(item, document, selectorDocument, selectorContext)
      return completion ? [completion] : []
    })
}

function isSelectorCompletionContext(context: SelectorCompletionContext) {
  const selector = context.text.trim()

  if (selector.startsWith('@') || !/:{1,2}[-\w]*$/.test(selector)) {
    return false
  }

  const selectorPrefix = selector.slice(0, selector.indexOf(':')).trim().toLowerCase()
  return !selectorPrefix.startsWith('--') && !cssPropertyNames.has(selectorPrefix)
}

function createSelectorDocument(
  document: vscode.TextDocument,
  context: SelectorCompletionContext,
): VirtualCssDocument {
  return {
    document: TextDocument.create(
      `next-yak:${document.uri.toString()}?selector-start=${context.sourceStart}`,
      'css',
      document.version,
      context.text,
    ),
    prefixLength: 0,
    sourceLength: context.text.length,
    sourceStart: context.sourceStart,
  }
}

function toSelectorCompletionItem(
  item: CssCompletionItem,
  document: vscode.TextDocument,
  selectorDocument: VirtualCssDocument,
  selectorContext: SelectorCompletionContext,
): vscode.CompletionItem | undefined {
  const completion = toCompletionItem(item, document, selectorDocument)
  const textEdit = getTextEdit(item)

  if (!completion || !textEdit) {
    return completion
  }

  const pseudoSelectorStart = selectorDocument.document.offsetAt(textEdit.range.start)
  const selectorRange = new vscode.Range(
    document.positionAt(selectorContext.sourceStart),
    document.positionAt(selectorContext.sourceStart + selectorContext.text.length),
  )
  const selectorText = `${selectorContext.text.slice(0, pseudoSelectorStart)}${textEdit.newText}`

  completion.range = selectorRange
  completion.insertText = toInsertText(selectorText, item.insertTextFormat)
  completion.filterText = selectorText

  return completion
}

function toCompletionItem(
  item: CssCompletionItem,
  document: vscode.TextDocument,
  virtualCss: VirtualCssDocument,
): vscode.CompletionItem | undefined {
  const completion = new vscode.CompletionItem(
    item.label,
    item.kind ? (item.kind as vscode.CompletionItemKind) : vscode.CompletionItemKind.Property,
  )
  const textEdit = getTextEdit(item)

  if (textEdit) {
    const range = toDocumentRange(textEdit.range, document, virtualCss)

    if (!range) {
      return undefined
    }

    completion.range = range
    completion.insertText = toInsertText(textEdit.newText, item.insertTextFormat)
    const replacementText = document.getText(range)
    const filterText = item.filterText ?? item.label

    completion.filterText = filterText
      .toLowerCase()
      .startsWith(replacementText.toLowerCase())
      ? replacementText
      : item.filterText
  } else if (item.insertText) {
    completion.insertText = toInsertText(item.insertText, item.insertTextFormat)
  }

  completion.detail = item.detail
  completion.documentation = toDocumentation(item.documentation)
  completion.filterText ??= item.filterText
  completion.preselect = item.preselect
  completion.sortText = `!${item.sortText ?? item.label}`

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
  virtualCss: VirtualCssDocument,
): vscode.Range | undefined {
  const sourceRange = mapVirtualRangeToSourceOffsets(
    virtualCss.document.offsetAt(range.start),
    virtualCss.document.offsetAt(range.end),
    virtualCss.prefixLength,
    virtualCss.sourceStart,
    virtualCss.sourceLength,
  )

  if (!sourceRange) {
    return undefined
  }

  return new vscode.Range(
    document.positionAt(sourceRange.start),
    document.positionAt(sourceRange.end),
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
