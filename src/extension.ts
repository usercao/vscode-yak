import * as vscode from 'vscode'
import {
  getDefaultCSSDataProvider,
  getCSSLanguageService,
  type CompletionItem as CssCompletionItem,
  type LanguageService as CssLanguageService,
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

import { mapVirtualCssCodeAction } from './codeActions'
import {
  getMappedCssColorPresentations,
  getMappedCssColors,
  type MappedCssColorPresentation,
} from './colors'
import { getMappedCssDiagnostics, type MappedCssDiagnostic } from './diagnostics'
import { getMappedCssHover, type VirtualCssDocument } from './hover'
import {
  createVirtualCssText,
  getAtRuleCompletionContext,
  getSelectorCompletionContext,
  mapVirtualRangeToSourceOffsets,
  type AtRuleCompletionContext,
  TemplateCache,
  type Template,
  type SelectorCompletionContext,
} from './template'
import {
  getTemplateLibraryProfiles,
  templateLibraryIds,
  type TemplateLibraryProfile,
} from './templateLibraries'

const cssLanguageService = getCSSLanguageService()
const cssPropertyNames = new Set(
  getDefaultCSSDataProvider()
    .provideProperties()
    .map((property) => property.name),
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
const supportedLanguageIds = new Set([
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
])
const cssDiagnosticSource = 'yak CSS'
type CssCompletionService = Pick<CssLanguageService, 'doComplete' | 'parseStylesheet'>

export interface CssLanguageRuntime extends vscode.Disposable {
  readonly codeActionProvider: CssCodeActionProvider
  readonly colorProvider: CssColorProvider
  readonly completionProvider: CssCompletionProvider
  readonly hoverProvider: CssHoverProvider
  clearTemplateCache(): void
  deleteDiagnostics(uri: vscode.Uri): void
  invalidateDocument(uri: string): void
  updateDiagnostics(document: vscode.TextDocument): void
}

export function createCssLanguageRuntime(): CssLanguageRuntime {
  const templateCache = new TemplateCache()
  const completionProvider = new CssCompletionProvider(templateCache)
  const hoverProvider = new CssHoverProvider(templateCache)
  const diagnostics = vscode.languages.createDiagnosticCollection('yak CSS')
  const diagnosticProvider = new CssDiagnosticProvider(templateCache, diagnostics)
  const codeActionProvider = new CssCodeActionProvider(templateCache)
  const colorProvider = new CssColorProvider(templateCache)

  const updateDiagnostics = (document: vscode.TextDocument) => {
    diagnosticProvider.updateDocument(document)
  }

  return {
    codeActionProvider,
    colorProvider,
    completionProvider,
    hoverProvider,
    clearTemplateCache: () => templateCache.clear(),
    deleteDiagnostics: (uri) => diagnostics.delete(uri),
    dispose: () => {
      templateCache.clear()
      diagnostics.dispose()
    },
    invalidateDocument: (uri) => templateCache.invalidateDocument(uri),
    updateDiagnostics,
  }
}

export class CssCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly templateCache = new TemplateCache(),
    private readonly cssCompletionService: CssCompletionService = cssLanguageService,
  ) {}

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
    const template = this.templateCache.findTemplate(
      {
        fileName: document.fileName,
        languageId: document.languageId,
        source,
        uri: document.uri.toString(),
        version: document.version,
      },
      cursorOffset,
      getTemplateLibraries(document.uri),
    )

    if (!template) {
      return undefined
    }

    const virtualCss = createVirtualCssDocument(document, template)
    const virtualOffset = virtualCss.prefixLength + cursorOffset - template.bodyStart
    const atRuleContext = getAtRuleCompletionContext(source, cursorOffset, template)
    const cssItems = getCssCompletionItems(
      this.cssCompletionService,
      virtualCss.document,
      virtualCss.document.positionAt(virtualOffset),
    )

    if (token.isCancellationRequested) {
      return undefined
    }

    const selectorContext = getSelectorCompletionContext(source, cursorOffset, template)
    const usesSelectorFallback = selectorContext && isSelectorCompletionContext(selectorContext)
    const items = cssItems
      .filter((item) =>
        shouldIncludeCssCompletion(item, atRuleContext, Boolean(usesSelectorFallback)),
      )
      .flatMap((item) => {
        const completion = toSafeCompletionItem(item, document, virtualCss)
        return completion ? [completion] : []
      })
    const existingLabels = new Set(
      items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label)),
    )
    const atRuleItems = getAtRuleCompletionItems(document, atRuleContext, existingLabels)
    atRuleItems.forEach((item) => existingLabels.add(completionLabel(item)))
    const selectorItems = getSelectorCompletionItems(
      this.cssCompletionService,
      source,
      cursorOffset,
      document,
      template,
      existingLabels,
    )

    if (token.isCancellationRequested) {
      return undefined
    }

    return new vscode.CompletionList([...items, ...atRuleItems, ...selectorItems], true)
  }
}

export class CssHoverProvider implements vscode.HoverProvider {
  constructor(private readonly templateCache = new TemplateCache()) {}

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
    const template = this.templateCache.findTemplate(
      {
        fileName: document.fileName,
        languageId: document.languageId,
        source,
        uri: document.uri.toString(),
        version: document.version,
      },
      cursorOffset,
      getTemplateLibraries(document.uri),
    )

    if (!template) {
      return undefined
    }

    const hover = getMappedCssHover(
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
      new vscode.Range(
        document.positionAt(hover.range.start),
        document.positionAt(hover.range.end),
      ),
    )
  }
}

export class CssDiagnosticProvider {
  constructor(
    private readonly templateCache: TemplateCache,
    private readonly diagnostics: vscode.DiagnosticCollection,
  ) {}

  updateDocument(document: vscode.TextDocument): void {
    if (!isSupportedDocument(document) || !isCssValidationEnabled(document.uri)) {
      this.diagnostics.delete(document.uri)
      return
    }

    const source = document.getText()
    const templates = this.templateCache.findTemplates(
      {
        fileName: document.fileName,
        languageId: document.languageId,
        source,
        uri: document.uri.toString(),
        version: document.version,
      },
      getTemplateLibraries(document.uri),
    )
    const mappedDiagnostics = templates.flatMap((template) => {
      const virtualCss = createVirtualCssDocument(document, template)

      return getMappedCssDiagnostics(cssLanguageService, template, virtualCss)
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

export class CssCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly templateCache = new TemplateCache()) {}

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
    const templates = this.templateCache.findTemplates(
      {
        fileName: document.fileName,
        languageId: document.languageId,
        source,
        uri: document.uri.toString(),
        version: document.version,
      },
      getTemplateLibraries(document.uri),
    )
    const actions: vscode.CodeAction[] = []

    for (const template of templates) {
      if (!isRangeInsideTemplate(range, document, template)) {
        continue
      }

      const virtualCss = createVirtualCssDocument(document, template)
      const mappedDiagnostics = getMappedCssDiagnostics(cssLanguageService, template, virtualCss)
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

        const action = new vscode.CodeAction(
          mappedAction.title,
          toCodeActionKind(mappedAction.kind),
        )
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

export class CssColorProvider implements vscode.DocumentColorProvider {
  constructor(private readonly templateCache = new TemplateCache()) {}

  provideDocumentColors(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.ColorInformation[] | undefined {
    if (token.isCancellationRequested || !isSupportedDocument(document)) {
      return undefined
    }

    const colors: vscode.ColorInformation[] = []

    for (const template of getDocumentTemplates(document, this.templateCache)) {
      const virtualCss = createVirtualCssDocument(document, template)

      for (const color of getMappedCssColors(cssLanguageService, template, virtualCss)) {
        if (token.isCancellationRequested) {
          return undefined
        }

        colors.push(
          new vscode.ColorInformation(
            toDocumentRangeFromOffsets(document, color.range),
            toVscodeColor(color.color),
          ),
        )
      }
    }

    return token.isCancellationRequested ? undefined : colors
  }

  provideColorPresentations(
    color: vscode.Color,
    context: { document: vscode.TextDocument; range: vscode.Range },
    token: vscode.CancellationToken,
  ): vscode.ColorPresentation[] | undefined {
    if (token.isCancellationRequested || !isSupportedDocument(context.document)) {
      return undefined
    }

    const sourceRange = toOffsetRange(context.document, context.range)

    for (const template of getDocumentTemplates(context.document, this.templateCache)) {
      if (!isRangeInsideTemplate(context.range, context.document, template)) {
        continue
      }

      const virtualCss = createVirtualCssDocument(context.document, template)
      const isKnownColorRange = getMappedCssColors(cssLanguageService, template, virtualCss).some(
        (knownColor) => isSameOffsetRange(knownColor.range, sourceRange),
      )

      if (!isKnownColorRange) {
        continue
      }

      const presentations = getMappedCssColorPresentations(
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

function isSupportedDocument(document: vscode.TextDocument) {
  return supportedLanguageIds.has(document.languageId)
}

function getDocumentTemplates(document: vscode.TextDocument, templateCache: TemplateCache) {
  return templateCache.findTemplates(
    getTemplateDocument(document),
    getTemplateLibraries(document.uri),
  )
}

function getTemplateLibraries(resource: vscode.Uri): readonly TemplateLibraryProfile[] {
  const ids = vscode.workspace
    .getConfiguration('yak', resource)
    .get<readonly string[]>('templateLibraries', templateLibraryIds)

  return getTemplateLibraryProfiles(ids)
}

function getTemplateDocument(document: vscode.TextDocument) {
  return {
    fileName: document.fileName,
    languageId: document.languageId,
    source: document.getText(),
    uri: document.uri.toString(),
    version: document.version,
  }
}

function toDocumentRangeFromOffsets(
  document: vscode.TextDocument,
  range: { end: number; start: number },
) {
  return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end))
}

function toOffsetRange(document: vscode.TextDocument, range: vscode.Range) {
  return {
    end: document.offsetAt(range.end),
    start: document.offsetAt(range.start),
  }
}

function isSameOffsetRange(
  left: { end: number; start: number },
  right: { end: number; start: number },
) {
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
  presentation: MappedCssColorPresentation,
) {
  const colorPresentation = new vscode.ColorPresentation(presentation.label)

  colorPresentation.textEdit = vscode.TextEdit.replace(
    toDocumentRangeFromOffsets(document, presentation.textEdit.range),
    presentation.textEdit.newText,
  )
  colorPresentation.additionalTextEdits = presentation.additionalTextEdits?.map((textEdit) =>
    vscode.TextEdit.replace(toDocumentRangeFromOffsets(document, textEdit.range), textEdit.newText),
  )

  return colorPresentation
}

function isCssValidationEnabled(resource: vscode.Uri) {
  return vscode.workspace.getConfiguration('yak', resource).get<boolean>('css.validate', true)
}

function toDiagnostic(
  document: vscode.TextDocument,
  mappedDiagnostic: MappedCssDiagnostic,
): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(
      document.positionAt(mappedDiagnostic.range.start),
      document.positionAt(mappedDiagnostic.range.end),
    ),
    mappedDiagnostic.diagnostic.message,
    toDiagnosticSeverity(mappedDiagnostic.diagnostic),
  )

  diagnostic.code = mappedDiagnostic.diagnostic.code
  diagnostic.source = cssDiagnosticSource

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
  mappedDiagnostics: readonly MappedCssDiagnostic[],
  diagnostics: readonly vscode.Diagnostic[],
) {
  return mappedDiagnostics.flatMap((mappedDiagnostic) => {
    const sourceRange = new vscode.Range(
      document.positionAt(mappedDiagnostic.range.start),
      document.positionAt(mappedDiagnostic.range.end),
    )
    const matchingDiagnostic = diagnostics.find(
      (diagnostic) =>
        diagnostic.source === cssDiagnosticSource &&
        diagnostic.code === mappedDiagnostic.diagnostic.code &&
        diagnostic.message === mappedDiagnostic.diagnostic.message &&
        diagnostic.range.isEqual(sourceRange),
    )

    return matchingDiagnostic
      ? [{ sourceDiagnostic: matchingDiagnostic, virtualDiagnostic: mappedDiagnostic.diagnostic }]
      : []
  })
}

function getActionDiagnostics(
  action: CssCodeAction,
  diagnostics: readonly { sourceDiagnostic: vscode.Diagnostic; virtualDiagnostic: CssDiagnostic }[],
) {
  if (!action.diagnostics || action.diagnostics.length === 0) {
    return []
  }

  return diagnostics.flatMap(({ sourceDiagnostic, virtualDiagnostic }) =>
    action.diagnostics?.some((actionDiagnostic) =>
      isSameCssDiagnostic(actionDiagnostic, virtualDiagnostic),
    )
      ? [sourceDiagnostic]
      : [],
  )
}

function isSameCssDiagnostic(left: CssDiagnostic, right: CssDiagnostic) {
  return (
    left.code === right.code &&
    left.message === right.message &&
    left.range.start.line === right.range.start.line &&
    left.range.start.character === right.range.start.character &&
    left.range.end.line === right.range.end.line &&
    left.range.end.character === right.range.end.character
  )
}

function getVirtualTemplateRange(template: Template, virtualCss: VirtualCssDocument): CssRange {
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
  template: Template,
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
  template: Template,
): VirtualCssDocument {
  const virtualCssText = createVirtualCssText(template)

  return {
    document: TextDocument.create(
      `yak:${document.uri.toString()}?start=${template.bodyStart}`,
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
  cssCompletionService: CssCompletionService,
  source: string,
  cursorOffset: number,
  document: vscode.TextDocument,
  template: Template,
  existingLabels: ReadonlySet<string>,
) {
  const selectorContext = getSelectorCompletionContext(source, cursorOffset, template)

  if (!selectorContext || !isSelectorCompletionContext(selectorContext)) {
    return []
  }

  const selectorDocument = createSelectorDocument(document, selectorContext)
  const cssItems = getCssCompletionItems(
    cssCompletionService,
    selectorDocument.document,
    selectorDocument.document.positionAt(selectorContext.text.length),
  )
  const completesPseudoSelector = selectorContext.text.includes(':')

  return cssItems
    .filter(
      (item) =>
        (completesPseudoSelector
          ? item.label.startsWith(':')
          : isTypeSelectorCompletion(item)) && !existingLabels.has(item.label),
    )
    .flatMap((item) => {
      const completion = toSafeSelectorCompletionItem(
        item,
        document,
        selectorDocument,
        selectorContext,
      )

      if (completion && !completesPseudoSelector) {
        const completesExactTypeSelector =
          item.label.toLowerCase() === selectorContext.text.toLowerCase()

        if (completesExactTypeSelector) {
          completion.filterText = selectorContext.text
          completion.preselect = true
        }
      }

      return completion ? [completion] : []
    })
}

function isTypeSelectorCompletion(item: CssCompletionItem) {
  return !item.label.startsWith(':') && /^[a-zA-Z][\w-]*$/.test(item.label)
}

function getCssCompletionItems(
  cssCompletionService: CssCompletionService,
  document: TextDocument,
  position: Parameters<CssCompletionService['doComplete']>[1],
): CssCompletionItem[] {
  try {
    const stylesheet = cssCompletionService.parseStylesheet(document)
    const completions = cssCompletionService.doComplete(document, position, stylesheet)

    return Array.isArray(completions?.items) ? completions.items.filter(isCssCompletionItem) : []
  } catch {
    return []
  }
}

function isCssCompletionItem(value: unknown): value is CssCompletionItem {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { label?: unknown }).label === 'string'
  )
}

function shouldIncludeCssCompletion(
  item: CssCompletionItem,
  atRuleContext: AtRuleCompletionContext | undefined,
  usesSelectorFallback: boolean,
) {
  if (
    atRuleContext?.kind === 'blocked' ||
    atRuleContext?.kind === 'descriptor' ||
    atRuleContext?.kind === 'name'
  ) {
    return false
  }

  if (item.label.startsWith('@')) {
    return false
  }

  if (atRuleContext?.kind === 'prelude') {
    return false
  }

  if (atRuleContext?.kind === 'rule' || atRuleContext?.kind === 'descriptor-value') {
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
    !context ||
    context.kind === 'blocked' ||
    context.kind === 'descriptor-value' ||
    context.kind === 'prelude' ||
    context.kind === 'rule'
  ) {
    return []
  }

  if (context.kind === 'descriptor') {
    const fallbackPropertyNames = descriptorFallbackPropertyNames.get(context.atRuleName)

    return cssProperties
      .filter(
        (property) =>
          property.atRule === context.atRuleName || fallbackPropertyNames?.has(property.name),
      )
      .filter((property) => property.name.startsWith(context.text.toLowerCase()))
      .filter((property) => !existingLabels.has(property.name))
      .map((property) =>
        toDataPropertyCompletionItem(property, document, context.sourceStart, context.text.length),
      )
  }

  return cssAtDirectives
    .filter(
      (atRule) =>
        nestedAtRuleNames.has(atRule.name) ||
        (context.allowsTopLevelRules && globalStyleAtRuleNames.has(atRule.name)),
    )
    .filter((atRule) => atRule.name.startsWith(context.text.toLowerCase()))
    .filter((atRule) => !existingLabels.has(atRule.name))
    .map((atRule) =>
      toAtRuleCompletionItem(atRule, document, context.sourceStart, context.text.length),
    )
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

  if (selector.startsWith('@')) {
    return false
  }

  if (/^[a-zA-Z][\w-]*$/.test(selector)) {
    return !cssPropertyNames.has(selector.toLowerCase())
  }

  if (!/:{1,2}[-\w]*$/.test(selector)) {
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
      `yak:${document.uri.toString()}?selector-start=${context.sourceStart}`,
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

function toSafeSelectorCompletionItem(
  item: CssCompletionItem,
  document: vscode.TextDocument,
  selectorDocument: VirtualCssDocument,
  selectorContext: SelectorCompletionContext,
): vscode.CompletionItem | undefined {
  try {
    return toSelectorCompletionItem(item, document, selectorDocument, selectorContext)
  } catch {
    return undefined
  }
}

function toSafeCompletionItem(
  item: CssCompletionItem,
  document: vscode.TextDocument,
  virtualCss: VirtualCssDocument,
): vscode.CompletionItem | undefined {
  try {
    return toCompletionItem(item, document, virtualCss)
  } catch {
    return undefined
  }
}

function toVscodeCompletionItemKind(kind: CssCompletionItem['kind']) {
  if (typeof kind !== 'number' || kind < 1 || kind > 25) {
    return vscode.CompletionItemKind.Property
  }

  // LSP completion kinds are one-based while the matching VS Code enum is zero-based.
  return (kind - 1) as vscode.CompletionItemKind
}

function toCompletionItem(
  item: CssCompletionItem,
  document: vscode.TextDocument,
  virtualCss: VirtualCssDocument,
): vscode.CompletionItem | undefined {
  const completion = new vscode.CompletionItem(item.label, toVscodeCompletionItemKind(item.kind))
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

    completion.filterText = filterText.toLowerCase().startsWith(replacementText.toLowerCase())
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
