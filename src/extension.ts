import * as vscode from 'vscode'
import {
  getDefaultCSSDataProvider,
  getCSSLanguageService,
  type CompletionItem as CssCompletionItem,
  type CodeAction as CssCodeAction,
  type CodeActionContext as CssCodeActionContext,
  type Color as CssColor,
  type Diagnostic as CssDiagnostic,
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
  getNextYakCssDiagnostics,
  type NextYakCssDiagnostic,
} from './nextYakDiagnostics'
import { mapVirtualCssCodeAction } from './nextYakCodeActions'
import {
  getNextYakCssColorPresentations,
  getNextYakCssColors,
  type NextYakCssColorPresentation,
} from './nextYakColors'
import { getNextYakStaticHighlightRanges } from './nextYakStaticHighlight'
import {
  createVirtualCssText,
  getAtRuleCompletionContext,
  getSelectorCompletionContext,
  mapVirtualRangeToSourceOffsets,
  NextYakStaticTemplateCache,
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
const nextYakLanguageIds = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact'])
const cssCompletionTriggerCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:-@'.split('')
const nextYakCssDiagnosticSource = 'next-yak CSS'
const nextYakCssValidateConfiguration = 'nextYak.css.validate'

export function activate(context: vscode.ExtensionContext) {
  const templateCache = new NextYakTemplateCache()
  const staticTemplateCache = new NextYakStaticTemplateCache()
  const staticTemplateHighlight = vscode.window.createTextEditorDecorationType({
    borderColor: new vscode.ThemeColor('editorInfo.foreground'),
    borderStyle: 'solid',
    borderWidth: '0 0 1px 0',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
  const completionProvider = new NextYakCssCompletionProvider(templateCache)
  const hoverProvider = new NextYakCssHoverProvider(templateCache)
  const diagnostics = vscode.languages.createDiagnosticCollection('next-yak CSS')
  const diagnosticProvider = new NextYakCssDiagnosticProvider(templateCache, diagnostics)
  const codeActionProvider = new NextYakCssCodeActionProvider(templateCache)
  const colorProvider = new NextYakCssColorProvider(templateCache)

  const updateDiagnostics = (document: vscode.TextDocument) => {
    diagnosticProvider.updateDocument(document)
  }

  const refreshDiagnostics = () => {
    for (const document of vscode.workspace.textDocuments) {
      updateDiagnostics(document)
    }
  }

  const refreshStaticTemplateHighlights = (editor: vscode.TextEditor) => {
    if (!isNextYakDocument(editor.document)) {
      editor.setDecorations(staticTemplateHighlight, [])
      return
    }

    const document = getNextYakTemplateDocument(editor.document)
    const ranges = getNextYakStaticHighlightRanges(document, staticTemplateCache)
      .map((range) => toDocumentRangeFromOffsets(editor.document, range))

    editor.setDecorations(staticTemplateHighlight, ranges.map((range) => ({
      hoverMessage: 'Static next-yak template pattern. CSS language features verify import ownership separately.',
      range,
    })))
  }

  const refreshVisibleStaticTemplateHighlights = () => {
    vscode.window.visibleTextEditors.forEach(refreshStaticTemplateHighlights)
  }

  context.subscriptions.push(
    diagnostics,
    staticTemplateHighlight,
    vscode.workspace.onDidChangeTextDocument((event) => {
      templateCache.invalidateDocument(event.document.uri.toString())
      staticTemplateCache.invalidateDocument(event.document.uri.toString())
      updateDiagnostics(event.document)
      vscode.window.visibleTextEditors
        .filter((editor) => editor.document.uri.toString() === event.document.uri.toString())
        .forEach(refreshStaticTemplateHighlights)
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      templateCache.invalidateDocument(document.uri.toString())
      staticTemplateCache.invalidateDocument(document.uri.toString())
      diagnostics.delete(document.uri)
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      updateDiagnostics(document)
    }),
    vscode.window.onDidChangeVisibleTextEditors(refreshVisibleStaticTemplateHighlights),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(nextYakCssValidateConfiguration)) {
        refreshDiagnostics()
      }
    }),
    vscode.languages.registerCompletionItemProvider(
      nextYakDocumentSelector,
      completionProvider,
      ...cssCompletionTriggerCharacters,
    ),
    vscode.languages.registerHoverProvider(nextYakDocumentSelector, hoverProvider),
    vscode.languages.registerCodeActionsProvider(
      nextYakDocumentSelector,
      codeActionProvider,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.languages.registerColorProvider(nextYakDocumentSelector, colorProvider),
  )

  refreshDiagnostics()
  refreshVisibleStaticTemplateHighlights()
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

export class NextYakCssDiagnosticProvider {
  constructor(
    private readonly templateCache: NextYakTemplateCache,
    private readonly diagnostics: vscode.DiagnosticCollection,
  ) {}

  updateDocument(document: vscode.TextDocument): void {
    if (!isNextYakDocument(document) || !isCssValidationEnabled(document.uri)) {
      this.diagnostics.delete(document.uri)
      return
    }

    const source = document.getText()
    const templates = this.templateCache.findTemplates({
      fileName: document.fileName,
      languageId: document.languageId,
      source,
      uri: document.uri.toString(),
      version: document.version,
    })
    const mappedDiagnostics = templates.flatMap((template) => {
      const virtualCss = createVirtualCssDocument(document, template)

      return getNextYakCssDiagnostics(cssLanguageService, template, virtualCss)
    })

    if (mappedDiagnostics.length === 0) {
      this.diagnostics.delete(document.uri)
      return
    }

    this.diagnostics.set(
      document.uri,
      mappedDiagnostics.map((diagnostic) => toDiagnostic(document, diagnostic)),
    )
  }
}

export class NextYakCssCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly templateCache = new NextYakTemplateCache()) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): vscode.CodeAction[] | undefined {
    if (token.isCancellationRequested || !isCssValidationEnabled(document.uri)) {
      return undefined
    }

    const source = document.getText()
    const templates = this.templateCache.findTemplates({
      fileName: document.fileName,
      languageId: document.languageId,
      source,
      uri: document.uri.toString(),
      version: document.version,
    })
    const actions: vscode.CodeAction[] = []

    for (const template of templates) {
      if (!isRangeInsideTemplate(range, document, template)) {
        continue
      }

      const virtualCss = createVirtualCssDocument(document, template)
      const mappedDiagnostics = getNextYakCssDiagnostics(cssLanguageService, template, virtualCss)
      const diagnostics = getMatchingDiagnostics(document, mappedDiagnostics, context.diagnostics)

      if (diagnostics.length === 0) {
        continue
      }

      const stylesheet = cssLanguageService.parseStylesheet(virtualCss.document)
      const virtualRange = getVirtualTemplateRange(template, virtualCss)
      const cssContext: CssCodeActionContext = {
        diagnostics: diagnostics.map(({ virtualDiagnostic }) => virtualDiagnostic),
      }
      const cssActions = cssLanguageService.doCodeActions2(
        virtualCss.document,
        virtualRange,
        cssContext,
        stylesheet,
      )

      for (const cssAction of cssActions) {
        const mappedAction = mapVirtualCssCodeAction(cssAction, template, virtualCss)
        const actionDiagnostics = getActionDiagnostics(cssAction, diagnostics)

        if (!mappedAction || actionDiagnostics.length === 0) {
          continue
        }

        const action = new vscode.CodeAction(mappedAction.title, toCodeActionKind(mappedAction.kind))
        const edit = new vscode.WorkspaceEdit()

        for (const textEdit of mappedAction.edits) {
          edit.replace(
            document.uri,
            new vscode.Range(
              document.positionAt(textEdit.range.start),
              document.positionAt(textEdit.range.end),
            ),
            textEdit.newText,
          )
        }

        action.diagnostics = actionDiagnostics
        action.edit = edit
        action.isPreferred = mappedAction.isPreferred
        actions.push(action)
      }
    }

    return token.isCancellationRequested ? undefined : actions
  }
}

export class NextYakCssColorProvider implements vscode.DocumentColorProvider {
  constructor(private readonly templateCache = new NextYakTemplateCache()) {}

  provideDocumentColors(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.ColorInformation[] | undefined {
    if (token.isCancellationRequested || !isNextYakDocument(document)) {
      return undefined
    }

    const colors: vscode.ColorInformation[] = []

    for (const template of getNextYakTemplates(document, this.templateCache)) {
      const virtualCss = createVirtualCssDocument(document, template)

      for (const color of getNextYakCssColors(cssLanguageService, template, virtualCss)) {
        if (token.isCancellationRequested) {
          return undefined
        }

        colors.push(new vscode.ColorInformation(
          toDocumentRangeFromOffsets(document, color.range),
          toVscodeColor(color.color),
        ))
      }
    }

    return token.isCancellationRequested ? undefined : colors
  }

  provideColorPresentations(
    color: vscode.Color,
    context: { document: vscode.TextDocument; range: vscode.Range },
    token: vscode.CancellationToken,
  ): vscode.ColorPresentation[] | undefined {
    if (token.isCancellationRequested || !isNextYakDocument(context.document)) {
      return undefined
    }

    const sourceRange = toOffsetRange(context.document, context.range)

    for (const template of getNextYakTemplates(context.document, this.templateCache)) {
      if (!isRangeInsideTemplate(context.range, context.document, template)) {
        continue
      }

      const virtualCss = createVirtualCssDocument(context.document, template)
      const isKnownColorRange = getNextYakCssColors(cssLanguageService, template, virtualCss)
        .some((knownColor) => isSameOffsetRange(knownColor.range, sourceRange))

      if (!isKnownColorRange) {
        continue
      }

      const presentations = getNextYakCssColorPresentations(
        cssLanguageService,
        toCssColor(color),
        sourceRange,
        template,
        virtualCss,
      ).map((presentation) => toVscodeColorPresentation(context.document, presentation))

      return token.isCancellationRequested ? undefined : presentations
    }

    return []
  }
}

function isNextYakDocument(document: vscode.TextDocument) {
  return nextYakLanguageIds.has(document.languageId)
}

function getNextYakTemplates(document: vscode.TextDocument, templateCache: NextYakTemplateCache) {
  return templateCache.findTemplates(getNextYakTemplateDocument(document))
}

function getNextYakTemplateDocument(document: vscode.TextDocument) {
  return {
    fileName: document.fileName,
    languageId: document.languageId,
    source: document.getText(),
    uri: document.uri.toString(),
    version: document.version,
  }
}

function toDocumentRangeFromOffsets(document: vscode.TextDocument, range: { end: number; start: number }) {
  return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end))
}

function toOffsetRange(document: vscode.TextDocument, range: vscode.Range) {
  return {
    end: document.offsetAt(range.end),
    start: document.offsetAt(range.start),
  }
}

function isSameOffsetRange(left: { end: number; start: number }, right: { end: number; start: number }) {
  return left.start === right.start && left.end === right.end
}

function toVscodeColor(color: CssColor) {
  return new vscode.Color(color.red, color.green, color.blue, color.alpha)
}

function toCssColor(color: vscode.Color): CssColor {
  return {
    alpha: color.alpha,
    blue: color.blue,
    green: color.green,
    red: color.red,
  }
}

function toVscodeColorPresentation(
  document: vscode.TextDocument,
  presentation: NextYakCssColorPresentation,
) {
  const colorPresentation = new vscode.ColorPresentation(presentation.label)

  colorPresentation.textEdit = vscode.TextEdit.replace(
    toDocumentRangeFromOffsets(document, presentation.textEdit.range),
    presentation.textEdit.newText,
  )
  colorPresentation.additionalTextEdits = presentation.additionalTextEdits?.map((textEdit) => (
    vscode.TextEdit.replace(toDocumentRangeFromOffsets(document, textEdit.range), textEdit.newText)
  ))

  return colorPresentation
}

function isCssValidationEnabled(resource: vscode.Uri) {
  return vscode.workspace.getConfiguration('nextYak', resource).get<boolean>('css.validate', true)
}

function toDiagnostic(document: vscode.TextDocument, mappedDiagnostic: NextYakCssDiagnostic): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(
      document.positionAt(mappedDiagnostic.range.start),
      document.positionAt(mappedDiagnostic.range.end),
    ),
    mappedDiagnostic.diagnostic.message,
    toDiagnosticSeverity(mappedDiagnostic.diagnostic),
  )

  diagnostic.code = mappedDiagnostic.diagnostic.code
  diagnostic.source = nextYakCssDiagnosticSource

  return diagnostic
}

function toDiagnosticSeverity(diagnostic: CssDiagnostic) {
  switch (diagnostic.severity) {
    case 1:
      return vscode.DiagnosticSeverity.Error
    case 2:
      return vscode.DiagnosticSeverity.Warning
    case 3:
      return vscode.DiagnosticSeverity.Information
    case 4:
      return vscode.DiagnosticSeverity.Hint
    default:
      return vscode.DiagnosticSeverity.Warning
  }
}

function getMatchingDiagnostics(
  document: vscode.TextDocument,
  mappedDiagnostics: readonly NextYakCssDiagnostic[],
  diagnostics: readonly vscode.Diagnostic[],
) {
  return mappedDiagnostics.flatMap((mappedDiagnostic) => {
    const sourceRange = new vscode.Range(
      document.positionAt(mappedDiagnostic.range.start),
      document.positionAt(mappedDiagnostic.range.end),
    )
    const matchingDiagnostic = diagnostics.find((diagnostic) => (
      diagnostic.source === nextYakCssDiagnosticSource
      && diagnostic.code === mappedDiagnostic.diagnostic.code
      && diagnostic.message === mappedDiagnostic.diagnostic.message
      && diagnostic.range.isEqual(sourceRange)
    ))

    return matchingDiagnostic ? [{ sourceDiagnostic: matchingDiagnostic, virtualDiagnostic: mappedDiagnostic.diagnostic }] : []
  })
}

function getActionDiagnostics(
  action: CssCodeAction,
  diagnostics: readonly { sourceDiagnostic: vscode.Diagnostic; virtualDiagnostic: CssDiagnostic }[],
) {
  if (!action.diagnostics || action.diagnostics.length === 0) {
    return []
  }

  return diagnostics.flatMap(({ sourceDiagnostic, virtualDiagnostic }) => (
    action.diagnostics?.some((actionDiagnostic) => isSameCssDiagnostic(actionDiagnostic, virtualDiagnostic))
      ? [sourceDiagnostic]
      : []
  ))
}

function isSameCssDiagnostic(left: CssDiagnostic, right: CssDiagnostic) {
  return left.code === right.code
    && left.message === right.message
    && left.range.start.line === right.range.start.line
    && left.range.start.character === right.range.start.character
    && left.range.end.line === right.range.end.line
    && left.range.end.character === right.range.end.character
}

function getVirtualTemplateRange(template: NextYakTemplate, virtualCss: VirtualCssDocument): CssRange {
  const start = virtualCss.prefixLength
  const end = start + template.maskedBody.length

  return {
    start: virtualCss.document.positionAt(start),
    end: virtualCss.document.positionAt(end),
  }
}

function isRangeInsideTemplate(
  range: vscode.Range,
  document: vscode.TextDocument,
  template: NextYakTemplate,
) {
  const start = document.offsetAt(range.start)
  const end = document.offsetAt(range.end)

  return start >= template.bodyStart && end <= template.bodyEnd
}

function toCodeActionKind(kind: string | undefined) {
  return kind === 'quickfix' ? vscode.CodeActionKind.QuickFix : undefined
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
  completion.command = item.command
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
