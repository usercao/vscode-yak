import * as vscode from 'vscode'
import {
  getDefaultCSSDataProvider,
  getCSSLanguageService,
  type CompletionItem as CssCompletionItem,
  type Hover as CssHover,
  type IAtDirectiveData,
  type IPropertyData,
  type MarkedString,
  type MarkupContent,
  type Range as CssRange,
} from 'vscode-css-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  getNextYakCssHover,
  type VirtualCssDocument,
} from './nextYakHover'
import {
  createVirtualCssText,
  getAtRuleCompletionContext,
  getSelectorCompletionContext,
  mapVirtualRangeToSourceOffsets,
  type AtRuleCompletionContext,
  NextYakTemplateCache,
  type NextYakTemplate,
  type SelectorCompletionContext,
} from './nextYakTemplate'

const cssLanguageService = getCSSLanguageService()
const cssPropertyNames = new Set(
  getDefaultCSSDataProvider().provideProperties().map((property) => property.name),
)
const cssAtDirectives = getDefaultCSSDataProvider().provideAtDirectives()
const cssProperties = getDefaultCSSDataProvider().provideProperties()
const globalStyleAtRuleNames = new Set([
  '@container',
  '@counter-style',
  '@font-face',
  '@font-feature-values',
  '@font-palette-values',
  '@keyframes',
  '@layer',
  '@media',
  '@page',
  '@position-try',
  '@property',
  '@scope',
  '@starting-style',
  '@supports',
  '@view-transition',
])
const nestedAtRuleNames = new Set([
  '@container',
  '@keyframes',
  '@layer',
  '@media',
  '@scope',
  '@starting-style',
  '@supports',
])
const descriptorFallbackPropertyNames = new Map<string, ReadonlySet<string>>([
  ['@font-face', new Set(['font-family'])],
])
const nextYakDocumentSelector: vscode.DocumentSelector = [
  { language: 'javascript' },
  { language: 'javascriptreact' },
  { language: 'typescript' },
  { language: 'typescriptreact' },
]
const cssCompletionTriggerCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:-@'.split('')

export function activate(context: vscode.ExtensionContext) {
  const templateCache = new NextYakTemplateCache()
  const completionProvider = new NextYakCssCompletionProvider(templateCache)
  const hoverProvider = new NextYakCssHoverProvider(templateCache)

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      templateCache.invalidateDocument(event.document.uri.toString())
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      templateCache.invalidateDocument(document.uri.toString())
    }),
    vscode.languages.registerCompletionItemProvider(
      nextYakDocumentSelector,
      completionProvider,
      ...cssCompletionTriggerCharacters,
    ),
    vscode.languages.registerHoverProvider(nextYakDocumentSelector, hoverProvider),
  )
}

export class NextYakCssCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly templateCache = new NextYakTemplateCache()) {}

  invalidateDocument(uri: string): void {
    this.templateCache.invalidateDocument(uri)
  }

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
    const template = this.templateCache.findTemplate({
      fileName: document.fileName,
      languageId: document.languageId,
      source,
      uri: document.uri.toString(),
      version: document.version,
    }, cursorOffset)

    if (!template) {
      return undefined
    }

    const virtualCss = createVirtualCssDocument(document, template)
    const virtualOffset = virtualCss.prefixLength + cursorOffset - template.bodyStart
    const stylesheet = cssLanguageService.parseStylesheet(virtualCss.document)
    const atRuleContext = getAtRuleCompletionContext(source, cursorOffset, template)
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
      .filter((item) => shouldIncludeCssCompletion(item, atRuleContext, Boolean(usesSelectorFallback)))
      .flatMap((item) => {
        const completion = toCompletionItem(item, document, virtualCss)
        return completion ? [completion] : []
      })
    const existingLabels = new Set(items.map((item) => typeof item.label === 'string' ? item.label : item.label.label))
    const atRuleItems = getAtRuleCompletionItems(document, atRuleContext, existingLabels)
    atRuleItems.forEach((item) => existingLabels.add(completionLabel(item)))
    const selectorItems = getSelectorCompletionItems(
      source,
      cursorOffset,
      document,
      template,
      existingLabels,
    )

    return new vscode.CompletionList([...items, ...atRuleItems, ...selectorItems], true)
  }
}

export class NextYakCssHoverProvider implements vscode.HoverProvider {
  constructor(private readonly templateCache = new NextYakTemplateCache()) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.Hover | undefined {
    if (token.isCancellationRequested) {
      return undefined
    }

    const source = document.getText()
    const cursorOffset = document.offsetAt(position)
    const template = this.templateCache.findTemplate({
      fileName: document.fileName,
      languageId: document.languageId,
      source,
      uri: document.uri.toString(),
      version: document.version,
    }, cursorOffset)

    if (!template) {
      return undefined
    }

    const hover = getNextYakCssHover(
      cssLanguageService,
      cursorOffset,
      template,
      createVirtualCssDocument(document, template),
    )

    if (!hover || token.isCancellationRequested) {
      return undefined
    }

    return new vscode.Hover(
      toHoverContents(hover.contents),
      new vscode.Range(document.positionAt(hover.range.start), document.positionAt(hover.range.end)),
    )
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

function shouldIncludeCssCompletion(
  item: CssCompletionItem,
  atRuleContext: AtRuleCompletionContext | undefined,
  usesSelectorFallback: boolean,
) {
  if (
    atRuleContext?.kind === 'blocked'
    || atRuleContext?.kind === 'descriptor'
    || atRuleContext?.kind === 'name'
  ) {
    return false
  }

  if (item.label.startsWith('@')) {
    return false
  }

  if (atRuleContext?.kind === 'prelude') {
    return false
  }

  if (
    atRuleContext?.kind === 'rule'
    || atRuleContext?.kind === 'descriptor-value'
  ) {
    return !item.label.startsWith(':')
  }

  return !usesSelectorFallback || !item.label.startsWith(':')
}

function getAtRuleCompletionItems(
  document: vscode.TextDocument,
  context: AtRuleCompletionContext | undefined,
  existingLabels: ReadonlySet<string>,
): vscode.CompletionItem[] {
  if (
    !context
    || context.kind === 'blocked'
    || context.kind === 'descriptor-value'
    || context.kind === 'prelude'
    || context.kind === 'rule'
  ) {
    return []
  }

  if (context.kind === 'descriptor') {
    const fallbackPropertyNames = descriptorFallbackPropertyNames.get(context.atRuleName)

    return cssProperties
      .filter((property) => property.atRule === context.atRuleName || fallbackPropertyNames?.has(property.name))
      .filter((property) => property.name.startsWith(context.text.toLowerCase()))
      .filter((property) => !existingLabels.has(property.name))
      .map((property) => toDataPropertyCompletionItem(property, document, context.sourceStart, context.text.length))
  }

  return cssAtDirectives
    .filter((atRule) => (
      nestedAtRuleNames.has(atRule.name)
      || (context.allowsTopLevelRules && globalStyleAtRuleNames.has(atRule.name))
    ))
    .filter((atRule) => atRule.name.startsWith(context.text.toLowerCase()))
    .filter((atRule) => !existingLabels.has(atRule.name))
    .map((atRule) => toAtRuleCompletionItem(atRule, document, context.sourceStart, context.text.length))
}

function toAtRuleCompletionItem(
  atRule: IAtDirectiveData,
  document: vscode.TextDocument,
  sourceStart: number,
  sourceLength: number,
) {
  const completion = new vscode.CompletionItem(atRule.name, vscode.CompletionItemKind.Keyword)

  completion.detail = 'CSS at-rule'
  completion.documentation = toDocumentation(atRule.description)
  completion.filterText = atRule.name
  completion.range = new vscode.Range(
    document.positionAt(sourceStart),
    document.positionAt(sourceStart + sourceLength),
  )
  completion.insertText = atRule.name
  completion.sortText = `!${atRule.name}`

  return completion
}

function toDataPropertyCompletionItem(
  property: IPropertyData,
  document: vscode.TextDocument,
  sourceStart: number,
  sourceLength: number,
) {
  const completion = new vscode.CompletionItem(property.name, vscode.CompletionItemKind.Property)

  completion.detail = property.syntax
  completion.documentation = toDocumentation(property.description)
  completion.filterText = property.name
  completion.range = new vscode.Range(
    document.positionAt(sourceStart),
    document.positionAt(sourceStart + sourceLength),
  )
  completion.insertText = new vscode.SnippetString(`${property.name}: $0;`)
  completion.sortText = `!${property.name}`

  return completion
}

function completionLabel(item: vscode.CompletionItem) {
  return typeof item.label === 'string' ? item.label : item.label.label
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

function toHoverContents(contents: CssHover['contents']): vscode.MarkdownString[] {
  const entries = Array.isArray(contents) ? contents : [contents]

  return entries.map((entry) => toHoverMarkdownString(entry))
}

function toHoverMarkdownString(content: MarkedString | MarkupContent): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString()

  if (typeof content === 'string') {
    return markdown.appendMarkdown(content)
  }

  if ('kind' in content) {
    return content.kind === 'markdown'
      ? markdown.appendMarkdown(content.value)
      : markdown.appendText(content.value)
  }

  return markdown.appendCodeblock(content.value, content.language)
}
