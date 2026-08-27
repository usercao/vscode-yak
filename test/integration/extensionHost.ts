import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as vscode from 'vscode'
import {
  getCSSLanguageService,
  newCSSDataProvider,
  type CSSDataV1,
  type CompletionList as CssCompletionList,
  type LanguageService as CssLanguageService,
} from 'vscode-css-languageservice'

const cursorMarker = '/*cursor*/'
const extensionSortPrefix = '!'
const completionLatencyBudgetMilliseconds = {
  continuousInput: 4_000,
  largeDocument: 5_000,
  manualTrigger: 2_000,
  singleCharacter: 1_500,
} as const
const activationEntrySizeBudgetBytes = 64 * 1024
const foldingEntrySizeBudgetBytes = 64 * 1024
const projectIndexEntrySizeBudgetBytes = 128 * 1024
const largeDocumentTemplateCount = 250
const projectIndexUpdatePollMilliseconds = 50
const projectIndexUpdateTimeoutMilliseconds = 5_000
type CssCompletionService = Pick<CssLanguageService, 'doComplete' | 'parseStylesheet'>

interface CompletionOptions {
  language?: string
  source: string
  uri?: vscode.Uri
}

interface PropertyCompletionOptions extends CompletionOptions {
  expectedLabel?: string
}

interface CompletionResult {
  document: vscode.TextDocument
  items: readonly vscode.CompletionItem[]
}

interface DirectCompletionProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.CompletionList | undefined
}

interface DirectCompletionProviderConstructor {
  new (
    templateCache?: undefined,
    cssCompletionService?: CssCompletionService,
  ): DirectCompletionProvider
}

interface DirectHoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.Hover | undefined
}

interface DirectHoverProviderConstructor {
  new (): DirectHoverProvider
}

interface DirectCodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): vscode.CodeAction[] | undefined
}

interface DirectCodeActionProviderConstructor {
  new (): DirectCodeActionProvider
}

interface DirectColorProvider {
  provideColorPresentations(
    color: vscode.Color,
    context: { document: vscode.TextDocument; range: vscode.Range },
    token: vscode.CancellationToken,
  ): vscode.ColorPresentation[] | undefined
  provideDocumentColors(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.ColorInformation[] | undefined
}

interface DirectColorProviderConstructor {
  new (): DirectColorProvider
}

interface ExtensionModule {
  CssCodeActionProvider?: DirectCodeActionProviderConstructor
  CssColorProvider?: DirectColorProviderConstructor
  CssCompletionProvider?: DirectCompletionProviderConstructor
  CssHoverProvider?: DirectHoverProviderConstructor
  default?: {
    CssCodeActionProvider?: DirectCodeActionProviderConstructor
    CssColorProvider?: DirectColorProviderConstructor
    CssCompletionProvider?: DirectCompletionProviderConstructor
    CssHoverProvider?: DirectHoverProviderConstructor
  }
}

interface ActivationApi {
  whenReady: PromiseLike<void>
}

function completionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === 'string' ? item.label : item.label.label
}

function completionInsertText(item: vscode.CompletionItem): string | undefined {
  return typeof item.insertText === 'string' ? item.insertText : item.insertText?.value
}

function completionRange(item: vscode.CompletionItem): vscode.Range {
  if (!(item.range instanceof vscode.Range)) {
    throw new Error(`Expected ${completionLabel(item)} to define a replacement range`)
  }

  return item.range
}

function extensionItems(items: readonly vscode.CompletionItem[]): vscode.CompletionItem[] {
  return items.filter((item) => item.sortText?.startsWith(extensionSortPrefix))
}

function findExtensionItem(
  items: readonly vscode.CompletionItem[],
  label: string,
): vscode.CompletionItem | undefined {
  return extensionItems(items).find((item) => completionLabel(item) === label)
}

function assertRangeWithinDocument(
  document: vscode.TextDocument,
  item: vscode.CompletionItem,
): void {
  const range = completionRange(item)
  const start = document.offsetAt(range.start)
  const end = document.offsetAt(range.end)

  assert.ok(start >= 0, `Expected ${completionLabel(item)} range to start inside the document`)
  assert.ok(end >= start, `Expected ${completionLabel(item)} range to be ordered`)
  assert.ok(
    end <= document.getText().length,
    `Expected ${completionLabel(item)} range to end inside the document`,
  )
}

async function completionItems({
  language = 'typescriptreact',
  source,
  uri,
}: CompletionOptions): Promise<CompletionResult> {
  const cursorOffset = source.indexOf(cursorMarker)

  assert.notEqual(cursorOffset, -1, `Missing ${cursorMarker} marker`)

  let document: vscode.TextDocument = uri
    ? await vscode.workspace.openTextDocument(uri)
    : await vscode.workspace.openTextDocument({
        language,
        content: source.replace(cursorMarker, ''),
      })

  if (document.languageId !== language) {
    document = await vscode.languages.setTextDocumentLanguage(document, language)
  }

  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })

  const completionList = await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
    'vscode.executeCompletionItemProvider',
    document.uri,
    document.positionAt(cursorOffset),
  )

  return { document, items: completionList?.items ?? [] }
}

function styledSource(
  prefix = 'col',
  tagExpression = 'styled.div',
  importStatement = "import { styled } from 'next-yak'",
): string {
  return [
    importStatement,
    `const Panel = ${tagExpression}\``,
    `  ${prefix}${cursorMarker}`,
    '`',
  ].join('\n')
}

function atRuleSource(
  prefix: string,
  tagExpression = 'styled.div',
  importStatement = "import { styled } from 'next-yak'",
): string {
  return [
    importStatement,
    `const Panel = ${tagExpression}\``,
    `  ${prefix}${cursorMarker}`,
    '`',
  ].join('\n')
}

async function assertPropertyCompletion(options: PropertyCompletionOptions): Promise<{
  document: vscode.TextDocument
  item: vscode.CompletionItem
  items: readonly vscode.CompletionItem[]
}> {
  const { expectedLabel = 'color', ...completionOptions } = options
  const { document, items } = await completionItems(completionOptions)
  const item = findExtensionItem(items, expectedLabel)

  assert.ok(
    item,
    `Expected yak ${expectedLabel} completion in ${extensionItems(items).map(completionLabel).join(', ')}`,
  )
  assertRangeWithinDocument(document, item)
  return { document, item, items }
}

async function assertPseudoCompletion(
  selector: string,
  expectedLabel: string,
  expectedInsertText: string,
): Promise<void> {
  const { document, items } = await completionItems({
    source: [
      "import { styled } from 'next-yak'",
      'const Link = styled.a`',
      `  ${selector}${cursorMarker}`,
      '`',
    ].join('\n'),
  })
  const item = findExtensionItem(items, expectedLabel)

  assert.ok(
    item,
    `Expected ${expectedLabel} in ${extensionItems(items).map(completionLabel).join(', ')}`,
  )
  const range = completionRange(item)
  assertRangeWithinDocument(document, item)
  assert.equal(document.getText(range), selector)
  assert.equal(item.filterText, expectedInsertText)
  assert.equal(completionInsertText(item), expectedInsertText)
}

async function assertAtRuleCompletion(
  source: string,
  expectedLabel: string,
  expectedReplacement: string,
  expectedInsertText = expectedLabel,
): Promise<{
  document: vscode.TextDocument
  item: vscode.CompletionItem
  items: readonly vscode.CompletionItem[]
}> {
  const { document, items } = await completionItems({ source })
  const item = findExtensionItem(items, expectedLabel)

  assert.ok(
    item,
    `Expected yak ${expectedLabel} completion in ${extensionItems(items).map(completionLabel).join(', ')}`,
  )
  assertRangeWithinDocument(document, item)
  assert.equal(document.getText(completionRange(item)), expectedReplacement)
  assert.equal(completionInsertText(item), expectedInsertText)

  return { document, item, items }
}

async function assertNoPseudoFallback(source: string): Promise<void> {
  const { items } = await completionItems({ source })
  const pseudoLabels = extensionItems(items)
    .map(completionLabel)
    .filter((label) => label.startsWith(':'))

  assert.deepEqual(
    pseudoLabels,
    [],
    `Expected no yak pseudo fallback, received ${pseudoLabels.join(', ')}`,
  )
}

async function assertNoAtRuleCompletion(source: string): Promise<void> {
  const { items } = await completionItems({ source })
  const atRuleLabels = extensionItems(items)
    .map(completionLabel)
    .filter((label) => label.startsWith('@'))

  assert.deepEqual(
    atRuleLabels,
    [],
    `Expected no yak at-rule completion, received ${atRuleLabels.join(', ')}`,
  )
}

async function assertNoExtensionCompletion(source: string): Promise<void> {
  const { items } = await completionItems({ source })
  const labels = extensionItems(items).map(completionLabel)

  assert.deepEqual(labels, [], `Expected no yak completion, received ${labels.join(', ')}`)
}

async function runCase(name: string, callback: () => Promise<void>): Promise<void> {
  try {
    await callback()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${name}: ${message}`, { cause: error })
  }
}

async function waitForProjectIndexUpdate(
  condition: () => Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + projectIndexUpdateTimeoutMilliseconds

  while (Date.now() < deadline) {
    if (await condition()) {
      return
    }

    await new Promise<void>((resolve) => setTimeout(resolve, projectIndexUpdatePollMilliseconds))
  }

  assert.fail(message)
}

async function updateWorkspaceFolders(
  update: () => boolean,
  isApplied: () => boolean,
  message: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let subscription: vscode.Disposable | undefined

  const didChange = new Promise<void>((resolve, reject) => {
    subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
      resolve()
    })
    timeout = setTimeout(
      () => reject(new Error(`${message}; no workspace folder change event`)),
      projectIndexUpdateTimeoutMilliseconds,
    )
  })

  if (!update()) {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
    subscription?.dispose()
    throw new Error(`${message}; updateWorkspaceFolders returned false`)
  }

  try {
    await didChange
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
    subscription?.dispose()
  }

  await waitForProjectIndexUpdate(async () => isApplied(), message)
}

async function createDirectProvider(
  extensionPath: string,
  cssCompletionService?: CssCompletionService,
): Promise<DirectCompletionProvider> {
  const extensionModule = (await import(
    pathToFileURL(join(extensionPath, 'dist', 'extension.mjs')).href
  )) as ExtensionModule
  const Provider =
    extensionModule.CssCompletionProvider ?? extensionModule.default?.CssCompletionProvider

  assert.ok(Provider, 'Expected the extension bundle to export CssCompletionProvider')
  return new Provider(undefined, cssCompletionService)
}

async function createDirectHoverProvider(extensionPath: string): Promise<DirectHoverProvider> {
  const extensionModule = (await import(
    pathToFileURL(join(extensionPath, 'dist', 'extension.mjs')).href
  )) as ExtensionModule
  const Provider = extensionModule.CssHoverProvider ?? extensionModule.default?.CssHoverProvider

  assert.ok(Provider, 'Expected the extension bundle to export CssHoverProvider')
  return new Provider()
}

async function createDirectCodeActionProvider(
  extensionPath: string,
): Promise<DirectCodeActionProvider> {
  const extensionModule = (await import(
    pathToFileURL(join(extensionPath, 'dist', 'extension.mjs')).href
  )) as ExtensionModule
  const Provider =
    extensionModule.CssCodeActionProvider ?? extensionModule.default?.CssCodeActionProvider

  assert.ok(Provider, 'Expected the extension bundle to export CssCodeActionProvider')
  return new Provider()
}

async function createDirectColorProvider(extensionPath: string): Promise<DirectColorProvider> {
  const extensionModule = (await import(
    pathToFileURL(join(extensionPath, 'dist', 'extension.mjs')).href
  )) as ExtensionModule
  const Provider = extensionModule.CssColorProvider ?? extensionModule.default?.CssColorProvider

  assert.ok(Provider, 'Expected the extension bundle to export CssColorProvider')
  return new Provider()
}

function cancellationToken(cancelOnCheck: number): vscode.CancellationToken {
  let checks = 0

  return {
    get isCancellationRequested() {
      checks += 1
      return checks >= cancelOnCheck
    },
    onCancellationRequested: () => new vscode.Disposable(() => {}),
  }
}

const neverCancelledToken: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => new vscode.Disposable(() => {}),
}

async function directProviderRequest(
  source: string,
  language = 'typescriptreact',
): Promise<{
  document: vscode.TextDocument
  position: vscode.Position
}> {
  const cursorOffset = source.indexOf(cursorMarker)

  assert.notEqual(cursorOffset, -1, `Missing ${cursorMarker} marker`)

  const document = await vscode.workspace.openTextDocument({
    language,
    content: source.replace(cursorMarker, ''),
  })

  return {
    document,
    position: document.positionAt(cursorOffset),
  }
}

async function completionItemsAt(
  document: vscode.TextDocument,
  cursorOffset: number,
): Promise<readonly vscode.CompletionItem[]> {
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })

  const completionList = await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
    'vscode.executeCompletionItemProvider',
    document.uri,
    document.positionAt(cursorOffset),
  )

  return completionList?.items ?? []
}

function hoverContentText(hover: vscode.Hover): string {
  return hover.contents
    .map((content) => (typeof content === 'string' ? content : content.value))
    .join('\n')
}

function hoverRange(hover: vscode.Hover): vscode.Range {
  if (!hover.range) {
    throw new Error('Expected hover to define a source replacement range')
  }

  return hover.range
}

async function registeredHoversAt(
  document: vscode.TextDocument,
  cursorOffset: number,
): Promise<readonly vscode.Hover[]> {
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })

  return vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    document.uri,
    document.positionAt(cursorOffset),
  )
}

async function registeredCodeActionsAt(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<readonly vscode.CodeAction[]> {
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })

  return vscode.commands.executeCommand<vscode.CodeAction[]>(
    'vscode.executeCodeActionProvider',
    document.uri,
    range,
    vscode.CodeActionKind.QuickFix.value,
  )
}

async function registeredDocumentColors(
  document: vscode.TextDocument,
): Promise<readonly vscode.ColorInformation[]> {
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })

  return vscode.commands.executeCommand<vscode.ColorInformation[]>(
    'vscode.executeDocumentColorProvider',
    document.uri,
  )
}

async function registeredColorPresentations(
  document: vscode.TextDocument,
  color: vscode.Color,
  range: vscode.Range,
): Promise<readonly vscode.ColorPresentation[]> {
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })

  return vscode.commands.executeCommand<vscode.ColorPresentation[]>(
    'vscode.executeColorPresentationProvider',
    color,
    { uri: document.uri, range },
  )
}

async function registeredFoldingRanges(
  document: vscode.TextDocument,
): Promise<readonly vscode.FoldingRange[]> {
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })

  return (
    (await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      'vscode.executeFoldingRangeProvider',
      document.uri,
    )) ?? []
  )
}

async function registeredDefinitionsAt(
  document: vscode.TextDocument,
  offset: number,
): Promise<readonly vscode.Location[]> {
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })

  return (
    (await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeDefinitionProvider',
      document.uri,
      document.positionAt(offset),
    )) ?? []
  )
}

async function registeredReferencesAt(
  document: vscode.TextDocument,
  offset: number,
): Promise<readonly vscode.Location[]> {
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })

  return (
    (await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      document.uri,
      document.positionAt(offset),
    )) ?? []
  )
}

function diagnosticsFor(document: vscode.TextDocument): readonly vscode.Diagnostic[] {
  return vscode.languages
    .getDiagnostics(document.uri)
    .filter((diagnostic) => diagnostic.source === 'yak CSS')
}

function diagnosticForText(
  document: vscode.TextDocument,
  text: string,
): vscode.Diagnostic | undefined {
  return diagnosticsFor(document).find((diagnostic) => document.getText(diagnostic.range) === text)
}

function workspaceEditEntries(
  action: vscode.CodeAction,
  document: vscode.TextDocument,
): readonly [vscode.Range, string][] {
  if (!action.edit) {
    throw new Error(`Expected ${action.title} to include a workspace edit`)
  }

  return action.edit
    .entries()
    .filter(([uri]) => uri.toString() === document.uri.toString())
    .flatMap(([, edits]) =>
      edits.map((edit) => [edit.range, edit.newText] as [vscode.Range, string]),
    )
}

async function resourceExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri)
    return true
  } catch {
    return false
  }
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('local.vscode-yak')

  assert.ok(extension, 'The yak extension should be available in the Extension Development Host')

  await runCase('keeps the synchronous activation entry lightweight', async () => {
    assert.equal(extension.packageJSON.main, './dist/activation.mjs')

    const activationEntry = await stat(join(extension.extensionPath, 'dist', 'activation.mjs'))
    const foldingEntry = await stat(join(extension.extensionPath, 'dist', 'folding.mjs'))
    const projectIndexEntry = await stat(
      join(extension.extensionPath, 'dist', 'projectIndexRuntime.mjs'),
    )

    assert.ok(
      activationEntry.size < activationEntrySizeBudgetBytes,
      `Expected activation entry under ${activationEntrySizeBudgetBytes} bytes; got ${activationEntry.size} bytes`,
    )
    assert.ok(
      foldingEntry.size < foldingEntrySizeBudgetBytes,
      `Expected independently loaded folding entry under ${foldingEntrySizeBudgetBytes} bytes; got ${foldingEntry.size} bytes`,
    )
    assert.ok(
      projectIndexEntry.size < projectIndexEntrySizeBudgetBytes,
      `Expected independently loaded project index entry under ${projectIndexEntrySizeBudgetBytes} bytes; got ${projectIndexEntry.size} bytes`,
    )
  })

  const activationApi = (await extension.activate()) as ActivationApi

  assert.ok(activationApi.whenReady, 'Expected the activation entry to expose runtime readiness')

  const startupSource = styledSource('col')
  const startupCursorOffset = startupSource.indexOf(cursorMarker)
  const startupDocument = await vscode.workspace.openTextDocument({
    language: 'typescriptreact',
    content: startupSource.replace(cursorMarker, ''),
  })
  const startupCompletions = await completionItemsAt(startupDocument, startupCursorOffset)

  assert.ok(
    findExtensionItem(startupCompletions, 'color'),
    'Expected the first completion request to wait for the lazy language runtime',
  )
  await activationApi.whenReady

  await runCase('completes CSS properties in every supported host language', async () => {
    for (const language of ['javascript', 'javascriptreact', 'typescript', 'typescriptreact']) {
      await assertPropertyCompletion({ language, source: styledSource() })
    }
  })

  await runCase('folds CSS blocks inside tagged templates', async () => {
    const source = [
      "import { styled } from 'next-yak'",
      'const Panel = styled.section`',
      '  h2 {',
      '    color: red;',
      '    @media (min-width: 48rem) {',
      '      color: blue;',
      '    }',
      '  }',
      '`',
    ].join('\n')
    const document = await vscode.workspace.openTextDocument({
      language: 'typescriptreact',
      content: source,
    })
    const ranges = await registeredFoldingRanges(document)

    assert.ok(
      ranges.some((range) => range.start === 2 && range.end === 7),
      'Expected a folding range for the h2 CSS rule',
    )
    assert.ok(
      ranges.some((range) => range.start === 4 && range.end === 6),
      'Expected a folding range for the nested media rule',
    )
  })

  await runCase('indexes workspace CSS tokens and static mixins', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    assert.ok(workspaceFolder, 'Expected the Extension Host test workspace')

    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspaceFolder.uri, 'projectIndexConsumer.tsx'),
    )
    const source = document.getText()
    const buttonTokenOffset = source.indexOf('--but') + '--but'.length
    const brandTokenOffset = source.indexOf('--brand') + 3
    const mixinOffset = source.indexOf('comp') + 'comp'.length
    const tokenCompletions = await completionItemsAt(document, buttonTokenOffset)
    const tokenItem = extensionItems(tokenCompletions).find(
      (item) => completionLabel(item) === 'var(--button-accent)',
    )
    const mixinCompletions = await completionItemsAt(document, mixinOffset)
    const mixinItem = extensionItems(mixinCompletions).find(
      (item) => completionLabel(item) === 'compact',
    )
    const definitions = await registeredDefinitionsAt(document, brandTokenOffset)
    const references = await registeredReferencesAt(document, brandTokenOffset)
    const hovers = await registeredHoversAt(document, brandTokenOffset)

    assert.ok(tokenItem, 'Expected a CSS Module token completion')
    assert.equal(completionInsertText(tokenItem), '--button-accent')
    assert.ok(mixinItem, 'Expected an exported static CSS mixin completion')
    assert.equal(completionInsertText(mixinItem), 'compact')
    assert.ok(
      mixinItem.additionalTextEdits?.some((edit) =>
        edit.newText.includes("import { compact } from './mixins'"),
      ),
      'Expected a safe named import for the external mixin',
    )
    assert.ok(
      definitions.some((location) => location.uri.path.endsWith('/tokens.css')),
      'Expected Go to Definition to locate the workspace token definition',
    )
    assert.ok(
      references.some((location) => location.uri.path.endsWith('/tokens.css')) &&
        references.some((location) => location.uri.toString() === document.uri.toString()),
      'Expected Find References to include the definition and yak usage',
    )
    assert.ok(
      hovers.some((hover) => hoverContentText(hover).includes('tokens.css')),
      'Expected token hover to identify its workspace source file',
    )
  })

  await runCase('updates the project CSS index for workspace file lifecycle changes', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    assert.ok(workspaceFolder, 'Expected the Extension Host test workspace')

    const fixtureDirectory = vscode.Uri.joinPath(workspaceFolder.uri, '.yak-project-index-fixture')
    const originalUri = vscode.Uri.joinPath(fixtureDirectory, 'lifecycle.css')
    const renamedUri = vscode.Uri.joinPath(fixtureDirectory, 'renamed.css')
    const consumerSource = [
      "import { styled } from 'next-yak'",
      'const LifecyclePanel = styled.div`',
      '  color: var(--lifecycle-);',
      '`',
    ].join('\n')
    const consumer = await vscode.workspace.openTextDocument({
      content: consumerSource,
      language: 'typescriptreact',
    })
    const completionOffset = consumerSource.indexOf('--lifecycle-') + '--lifecycle-'.length
    const referenceSource = [
      "import { styled } from 'next-yak'",
      'const LifecycleReference = styled.div`',
      '  color: var(--lifecycle-next);',
      '`',
    ].join('\n')
    const reference = await vscode.workspace.openTextDocument({
      content: referenceSource,
      language: 'typescriptreact',
    })
    const referenceOffset = referenceSource.indexOf('--lifecycle-next') + 4
    const projectCompletionLabels = async () =>
      extensionItems(await completionItemsAt(consumer, completionOffset)).map(completionLabel)

    try {
      await vscode.workspace.fs.createDirectory(fixtureDirectory)
      await vscode.workspace.fs.writeFile(
        originalUri,
        new TextEncoder().encode(':root { --lifecycle-token: #176b5b; }\n'),
      )

      await waitForProjectIndexUpdate(
        async () => (await projectCompletionLabels()).includes('var(--lifecycle-token)'),
        'Expected a newly created workspace token to appear in completion',
      )

      const tokenDocument = await vscode.workspace.openTextDocument(originalUri)
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        originalUri,
        new vscode.Range(
          tokenDocument.positionAt(0),
          tokenDocument.positionAt(tokenDocument.getText().length),
        ),
        ':root { --lifecycle-next: #176b5b; }\n',
      )
      assert.ok(await vscode.workspace.applyEdit(edit), 'Expected the token file edit to apply')
      assert.ok(await tokenDocument.save(), 'Expected the token file edit to save')

      await waitForProjectIndexUpdate(async () => {
        const labels = await projectCompletionLabels()
        return (
          labels.includes('var(--lifecycle-next)') && !labels.includes('var(--lifecycle-token)')
        )
      }, 'Expected an edited workspace token to replace its stale completion')

      await vscode.workspace.fs.rename(originalUri, renamedUri, { overwrite: false })

      await waitForProjectIndexUpdate(
        async () =>
          (await registeredDefinitionsAt(reference, referenceOffset)).some(
            (location) => location.uri.toString() === renamedUri.toString(),
          ),
        'Expected Go to Definition to follow a renamed workspace token file',
      )

      await vscode.workspace.fs.delete(renamedUri, { useTrash: false })

      await waitForProjectIndexUpdate(
        async () =>
          !(await registeredDefinitionsAt(reference, referenceOffset)).some(
            (location) => location.uri.toString() === renamedUri.toString(),
          ),
        'Expected a deleted workspace token file to be removed from Go to Definition',
      )
    } finally {
      await vscode.workspace.fs.delete(fixtureDirectory, { recursive: true, useTrash: false })
    }
  })

  await runCase('reindexes project CSS when workspace folders change', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders
    assert.ok(workspaceFolders, 'Expected Extension Host workspace folders')

    const additionalFolder = workspaceFolders.find(
      (folder) => folder.name === 'test-workspace-extra',
    )
    assert.ok(additionalFolder, 'Expected the additional project index workspace fixture')

    const consumerSource = [
      "import { styled } from 'next-yak'",
      'const WorkspaceFolderPanel = styled.div`',
      '  color: var(--workspace-folder-);',
      '`',
    ].join('\n')
    const consumer = await vscode.workspace.openTextDocument({
      content: consumerSource,
      language: 'typescriptreact',
    })
    const completionOffset =
      consumerSource.indexOf('--workspace-folder-') + '--workspace-folder-'.length
    const projectCompletionLabels = async () =>
      extensionItems(await completionItemsAt(consumer, completionOffset)).map(completionLabel)
    const isAdditionalFolderPresent = () =>
      vscode.workspace.workspaceFolders?.some(
        (folder) => folder.uri.toString() === additionalFolder.uri.toString(),
      ) ?? false
    try {
      await waitForProjectIndexUpdate(
        async () => (await projectCompletionLabels()).includes('var(--workspace-folder-token)'),
        'Expected a token from the additional workspace folder before removal',
      )

      const additionalFolderIndex = vscode.workspace.workspaceFolders?.findIndex(
        (folder) => folder.uri.toString() === additionalFolder.uri.toString(),
      )

      if (additionalFolderIndex === undefined || additionalFolderIndex < 0) {
        throw new Error('Expected the additional folder to remain registered')
      }

      await updateWorkspaceFolders(
        () => vscode.workspace.updateWorkspaceFolders(additionalFolderIndex, 1),
        () => !isAdditionalFolderPresent(),
        'Expected the additional workspace folder to be removed',
      )

      await waitForProjectIndexUpdate(
        async () => !(await projectCompletionLabels()).includes('var(--workspace-folder-token)'),
        'Expected a removed workspace folder token to leave completion',
      )

      await updateWorkspaceFolders(
        () =>
          vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders?.length ?? 0,
            null,
            {
              uri: additionalFolder.uri,
              name: additionalFolder.name,
            },
          ),
        isAdditionalFolderPresent,
        'Expected the additional workspace folder to be restored',
      )

      await waitForProjectIndexUpdate(
        async () => (await projectCompletionLabels()).includes('var(--workspace-folder-token)'),
        'Expected a restored workspace folder token to return to completion',
      )
    } finally {
      if (!isAdditionalFolderPresent()) {
        await updateWorkspaceFolders(
          () =>
            vscode.workspace.updateWorkspaceFolders(
              vscode.workspace.workspaceFolders?.length ?? 0,
              null,
              {
                uri: additionalFolder.uri,
                name: additionalFolder.name,
              },
            ),
          isAdditionalFolderPresent,
          'Expected the additional workspace folder to be restored during cleanup',
        )
      }
    }
  })

  await runCase('completes supported yak tagged template forms', async () => {
    await assertPropertyCompletion({
      source: [
        "import { globalStyle } from 'next-yak'",
        'globalStyle`',
        `  col${cursorMarker}`,
        '`',
      ].join('\n'),
    })
    await assertPropertyCompletion({
      source: [
        "import { keyframes } from 'next-yak'",
        'const fade = keyframes`',
        '  from {',
        `    op${cursorMarker}`,
        '  }',
        '`',
      ].join('\n'),
      expectedLabel: 'opacity',
    })
    await assertPropertyCompletion({
      source: [
        "import { styled } from 'next-yak'",
        'const Component = () => null',
        'const Panel = styled(Component)`',
        `  col${cursorMarker}`,
        '`',
      ].join('\n'),
    })
    await assertPropertyCompletion({ source: styledSource('col', 'styled.div.attrs({})') })
    await assertPropertyCompletion({ source: styledSource('col', "styled['div']") })
    await assertPropertyCompletion({
      source: styledSource('col', 'styled.div<{ active: boolean }>'),
    })
    await assertPropertyCompletion({
      source: styledSource(
        'col',
        'styled(Component).attrs<{ active: boolean }>({ role: "region" })',
      ),
    })
    await assertPropertyCompletion({
      source: styledSource('col', 'yak.styled.div', "import * as yak from 'next-yak'"),
    })
  })

  await runCase('completes current next-yak and styled-components templates', async () => {
    await assertPropertyCompletion({
      source: styledSource('col', 'styled.div', "import { styled } from 'next-yak'"),
    })
    await assertPropertyCompletion({
      source: styledSource('col', 'styled.div', "import { styled } from '@yak/react'"),
    })
    await assertPropertyCompletion({
      source: styledSource('col', 'styled.div', "import { styled } from '@yak/solid'"),
    })
    await assertPropertyCompletion({
      source: styledSource('col', 'styled.button', "import styled from 'styled-components'"),
    })
    await assertPropertyCompletion({
      source: [
        "import { createGlobalStyle } from 'styled-components'",
        'const GlobalStyle = createGlobalStyle`',
        `  col${cursorMarker}`,
        '`',
      ].join('\n'),
    })
  })

  await runCase('does not recognize the removed yak package name', async () => {
    await assertNoExtensionCompletion(
      styledSource('col', 'styled.div', "import { styled } from 'yak'"),
    )
  })

  await runCase('honors configured template library profiles', async () => {
    const source = [
      "import styled from 'styled-components'",
      'const Panel = styled.div`',
      `  col${cursorMarker}`,
      '  colro: red;',
      '`',
    ].join('\n')
    const cursorOffset = source.indexOf(cursorMarker)
    const document = await vscode.workspace.openTextDocument({
      language: 'typescriptreact',
      content: source.replace(cursorMarker, ''),
    })
    const configuration = vscode.workspace.getConfiguration('yak', document.uri)
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    const settingsDirectory = workspaceFolder && vscode.Uri.joinPath(workspaceFolder.uri, '.vscode')
    const settingsFile =
      settingsDirectory && vscode.Uri.joinPath(settingsDirectory, 'settings.json')
    const settingsDirectoryExisted = settingsDirectory
      ? await resourceExists(settingsDirectory)
      : true
    const settingsFileExisted = settingsFile ? await resourceExists(settingsFile) : true
    const previousWorkspaceValue =
      configuration.inspect<readonly string[]>('templateLibraries')?.workspaceValue

    try {
      assert.ok(diagnosticForText(document, 'colro'), 'Expected initial CSS diagnostic')
      assert.ok(
        findExtensionItem(await completionItemsAt(document, cursorOffset), 'color'),
        'Expected initial styled-components completion',
      )

      await configuration.update('templateLibraries', ['yak'], vscode.ConfigurationTarget.Workspace)
      assert.deepEqual(extensionItems(await completionItemsAt(document, cursorOffset)), [])
      assert.equal(
        diagnosticForText(document, 'colro'),
        undefined,
        'Expected diagnostics to clear when the styled-components Profile is disabled',
      )
      await configuration.update(
        'templateLibraries',
        ['yak', 'styled-components'],
        vscode.ConfigurationTarget.Workspace,
      )
      assert.ok(
        findExtensionItem(await completionItemsAt(document, cursorOffset), 'color'),
        'Expected styled-components completion after re-enabling its Profile',
      )
      assert.ok(
        diagnosticForText(document, 'colro'),
        'Expected diagnostics to return after re-enabling the styled-components Profile',
      )
    } finally {
      await configuration.update(
        'templateLibraries',
        previousWorkspaceValue,
        vscode.ConfigurationTarget.Workspace,
      )

      if (settingsFile && !settingsFileExisted && (await resourceExists(settingsFile))) {
        await vscode.workspace.fs.delete(settingsFile, { useTrash: false })
      }

      if (
        settingsDirectory &&
        !settingsDirectoryExisted &&
        (await resourceExists(settingsDirectory))
      ) {
        await vscode.workspace.fs.delete(settingsDirectory, { recursive: false, useTrash: false })
      }
    }
  })

  await runCase('shares CSS language features with styled-components templates', async () => {
    const source = [
      "import styled from 'styled-components'",
      'const Panel = styled.div`',
      '  display: grid;',
      '  color: rebeccapurple;',
      '  colro: red;',
      '`',
    ].join('\n')
    const document = await vscode.workspace.openTextDocument({
      language: 'typescriptreact',
      content: source,
    })
    const displayOffset = source.indexOf('display')
    const hovers = await registeredHoversAt(document, displayOffset)
    const typo = diagnosticForText(document, 'colro')
    const colors = await registeredDocumentColors(document)

    assert.ok(
      hovers.some((hover) => hoverContentText(hover).includes('MDN Reference')),
      'Expected a CSS property hover for a styled-components template',
    )
    assert.ok(typo, 'Expected a CSS diagnostic for a styled-components template')
    assert.deepEqual(
      colors.map((color) => document.getText(color.range)),
      ['rebeccapurple', 'red'],
      'Expected a mapped CSS color for a styled-components template',
    )

    const provider = await createDirectCodeActionProvider(extension.extensionPath)
    const actions = provider.provideCodeActions(
      document,
      typo.range,
      {
        diagnostics: [typo],
        only: vscode.CodeActionKind.QuickFix,
        triggerKind: vscode.CodeActionTriggerKind.Invoke,
      },
      neverCancelledToken,
    )
    const availableActions = actions ?? []

    assert.ok(
      availableActions.some((action) => action.title.includes("Rename to 'color'")),
      'Expected a CSS quick fix for a styled-components template',
    )
  })

  await runCase('completes CSS prop and nearest nested templates', async () => {
    await assertPropertyCompletion({
      source: [
        "import { css } from 'next-yak'",
        'const view = <section css={css`',
        `  col${cursorMarker}`,
        '`} />',
      ].join('\n'),
    })
    await assertPropertyCompletion({
      source: [
        "import * as yak from 'next-yak'",
        'const view = <section css={yak.css`',
        `  col${cursorMarker}`,
        '`} />',
      ].join('\n'),
    })

    const { document, item } = await assertPropertyCompletion({
      source: [
        "import { css, styled } from 'next-yak'",
        'const Panel = styled.div`',
        '  ${({ active }) => active && css`',
        `    col${cursorMarker}`,
        '  `}',
        '`',
      ].join('\n'),
    })
    assert.equal(document.getText(completionRange(item)), 'col')
  })

  await runCase('maps replacement ranges and snippets inside multiline templates', async () => {
    const replacement = await assertPropertyCompletion({
      source: [
        "import { styled } from 'next-yak'",
        'const Panel = styled.div`',
        '  display: grid;',
        `  col${cursorMarker}`,
        '`',
      ].join('\n'),
    })
    const replacementRange = completionRange(replacement.item)
    assert.equal(replacement.document.getText(replacementRange), 'col')
    assert.equal(replacementRange.start.line, 3)
    assert.equal(replacementRange.end.line, 3)
    assert.equal(completionInsertText(replacement.item), 'color: $0;')
    assert.equal(replacement.item.command?.command, 'editor.action.triggerSuggest')

    const insertion = await assertPropertyCompletion({ source: styledSource('') })
    const insertionRange = completionRange(insertion.item)
    assert.equal(insertion.document.getText(insertionRange), '')
    assert.ok(insertionRange.isEmpty, 'Expected an insertion range at an empty CSS position')

    const value = await assertPropertyCompletion({
      source: styledSource('animation: '),
      expectedLabel: 'steps()',
    })
    assert.equal(value.document.getText(completionRange(value.item)), '')
    assert.equal(completionInsertText(value.item), 'steps($1)')
  })

  await runCase('returns pseudo selectors with complete replacement text', async () => {
    await assertPseudoCompletion('a:', ':hover', 'a:hover')
    await assertPseudoCompletion('a:ho', ':hover', 'a:hover')
    await assertPseudoCompletion('a::', '::before', 'a::before')
    await assertPseudoCompletion('.link:ho', ':hover', '.link:hover')
    await assertPseudoCompletion('&:fo', ':focus', '&:focus')
  })

  await runCase('prioritizes CSS type selectors over Emmet expansions', async () => {
    for (const selector of ['div', 'button', 'section', 'input']) {
      const prefix = selector.toUpperCase()
      const source = styledSource(prefix)
      const cursorOffset = source.indexOf(cursorMarker)
      const { document, items } = await completionItems({ source })
      const item = findExtensionItem(items, selector)

      assert.ok(
        item,
        `Expected ${selector} in ${extensionItems(items).map(completionLabel).join(', ')}`,
      )
      assert.equal(document.getText(completionRange(item)), prefix)
      assert.equal(completionInsertText(item), selector)
      assert.equal(item.filterText, prefix)
      assert.equal(item.kind, vscode.CompletionItemKind.Keyword)
      assert.equal(item.preselect, true)

      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
      })
      const cursorPosition = document.positionAt(cursorOffset)
      editor.selection = new vscode.Selection(cursorPosition, cursorPosition)

      await vscode.commands.executeCommand('editor.action.triggerSuggest', { auto: true })
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      await vscode.commands.executeCommand('acceptSelectedSuggestion')
      await new Promise<void>((resolve) => setTimeout(resolve, 100))

      assert.ok(
        document.getText().includes(`  ${selector}\n`),
        `Expected ${selector} after accepting the selected suggestion, received ${document.getText()}`,
      )
      assert.ok(
        !document.getText().includes('<'),
        `Expected the selected CSS suggestion to avoid HTML expansion, received ${document.getText()}`,
      )
    }
  })

  await runCase('keeps CSS type selectors selected while typing', async () => {
    const source = styledSource('')
    const cursorOffset = source.indexOf(cursorMarker)
    const document = await vscode.workspace.openTextDocument({
      language: 'typescriptreact',
      content: source.replace(cursorMarker, ''),
    })
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    })
    const cursorPosition = document.positionAt(cursorOffset)
    editor.selection = new vscode.Selection(cursorPosition, cursorPosition)

    for (const character of 'DIV') {
      await vscode.commands.executeCommand('type', { text: character })
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }

    await vscode.commands.executeCommand('editor.action.triggerSuggest', { auto: true })
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    await vscode.commands.executeCommand('acceptSelectedSuggestion')
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    assert.ok(
      document.getText().includes('  div\n'),
      `Expected CSS div completion to replace DIV, received ${document.getText()}`,
    )
    assert.ok(
      !document.getText().includes('<div>'),
      `Expected the selected CSS suggestion to avoid HTML expansion, received ${document.getText()}`,
    )
  })

  await runCase('does not use pseudo fallback in declaration and at-rule contexts', async () => {
    const sourceForLine = (line: string): string =>
      [
        "import { styled } from 'next-yak'",
        'const Panel = styled.div`',
        `  ${line}${cursorMarker}`,
        '`',
      ].join('\n')

    await assertNoPseudoFallback(sourceForLine('unknown: value'))
    await assertNoPseudoFallback(sourceForLine('color: re'))
    await assertNoPseudoFallback(sourceForLine('@media '))
    await assertNoExtensionCompletion(sourceForLine('@media '))
    await assertNoPseudoFallback(sourceForLine('--accent:'))
  })

  await runCase('completes standard at-rule names with safe replacement ranges', async () => {
    const root = await assertAtRuleCompletion(atRuleSource('@'), '@media', '@')
    const rootLabels = new Set(extensionItems(root.items).map(completionLabel))

    for (const label of ['@media', '@supports', '@container', '@layer', '@scope', '@keyframes']) {
      assert.ok(rootLabels.has(label), `Expected ${label} in standard at-rule candidates`)
    }
    for (const label of ['@font-face', '@property', '@charset', '@import', '@namespace']) {
      assert.ok(!rootLabels.has(label), `Expected ${label} to be unavailable inside a styled rule`)
    }

    await assertAtRuleCompletion(atRuleSource('@med'), '@media', '@med')

    const global = await assertAtRuleCompletion(
      atRuleSource('@', 'globalStyle', "import { globalStyle } from 'next-yak'"),
      '@font-face',
      '@',
    )
    const globalLabels = new Set(extensionItems(global.items).map(completionLabel))

    for (const label of ['@font-face', '@property', '@counter-style', '@page']) {
      assert.ok(globalLabels.has(label), `Expected ${label} in globalStyle at-rule candidates`)
    }
    for (const label of ['@charset', '@import', '@namespace']) {
      assert.ok(
        !globalLabels.has(label),
        `Expected ${label} to remain unavailable in a tagged template`,
      )
    }
  })

  await runCase(
    'keeps at-rule completions scoped to valid names and nested rule bodies',
    async () => {
      const nested = await assertPropertyCompletion({
        source: [
          "import { styled } from 'next-yak'",
          'const Panel = styled.div`',
          '  @media (min-width: 48rem) {',
          `    dis${cursorMarker}`,
          '  }',
          '`',
        ].join('\n'),
        expectedLabel: 'display',
      })
      assert.equal(nested.document.getText(completionRange(nested.item)), 'dis')
      assert.deepEqual(
        extensionItems(nested.items)
          .map(completionLabel)
          .filter((label) => label.startsWith('@') || label.startsWith(':')),
        [],
        'Expected only declaration-context candidates inside a media rule body',
      )

      await assertAtRuleCompletion(
        [
          "import { styled } from 'next-yak'",
          'const Panel = styled.div`',
          '  @media (min-width: 48rem) {',
          `    @sup${cursorMarker}`,
          '  }',
          '`',
        ].join('\n'),
        '@supports',
        '@sup',
      )

      const descriptor = await assertAtRuleCompletion(
        [
          "import { globalStyle } from 'next-yak'",
          'const Panel = globalStyle`',
          '  @property --size {',
          `    syn${cursorMarker}`,
          '  }',
          '`',
        ].join('\n'),
        'syntax',
        'syn',
        'syntax: $0;',
      )
      assert.deepEqual(
        extensionItems(descriptor.items)
          .map(completionLabel)
          .filter((label) => label.startsWith('@')),
        [],
        'Expected no at-rule candidates inside a descriptor block',
      )

      const fontFace = await assertAtRuleCompletion(
        [
          "import { globalStyle } from 'next-yak'",
          'const Panel = globalStyle`',
          '  @font-face {',
          `    font-f${cursorMarker}`,
          '  }',
          '`',
        ].join('\n'),
        'font-family',
        'font-f',
        'font-family: $0;',
      )
      assert.deepEqual(
        extensionItems(fontFace.items)
          .map(completionLabel)
          .filter((label) => label.startsWith('@')),
        [],
        'Expected no at-rule candidates inside a font-face descriptor block',
      )

      for (const source of [
        atRuleSource('color: @'),
        atRuleSource('/* @med'),
        atRuleSource('content: "@med'),
        atRuleSource('background: url(@med'),
        [
          "import { styled } from 'next-yak'",
          'const Panel = styled.div`',
          '  @property --size {',
          `    @med${cursorMarker}`,
          '  }',
          '`',
        ].join('\n'),
        [
          "import { styled } from 'next-yak'",
          'const Panel = styled.div`',
          '  @property --size {',
          `    syn${cursorMarker}`,
          '  }',
          '`',
        ].join('\n'),
        [
          "import { styled } from 'next-yak'",
          'const Panel = styled.div`',
          `  color: \${value.${cursorMarker}accent};`,
          '`',
        ].join('\n'),
        [
          "import { keyframes } from 'next-yak'",
          'const spin = keyframes`',
          `  @med${cursorMarker}`,
          '`',
        ].join('\n'),
      ]) {
        await assertNoAtRuleCompletion(source)
      }
    },
  )

  await runCase('rejects type-only, locally shadowed, and dynamic yak tags', async () => {
    for (const source of [
      styledSource('col', 'styled.div', "import type { styled } from 'next-yak'"),
      [
        "import { styled } from 'next-yak'",
        'function create(styled) {',
        '  return styled.a`',
        `    col${cursorMarker}`,
        '  `',
        '}',
      ].join('\n'),
      [
        "import { styled } from 'next-yak'",
        "const tagName = 'div'",
        'const Panel = styled[tagName]`',
        `  col${cursorMarker}`,
        '`',
      ].join('\n'),
      [
        'const styled = createFactory()',
        'const Panel = styled.div`',
        `  col${cursorMarker}`,
        '`',
      ].join('\n'),
    ]) {
      const { items } = await completionItems({ source })
      assert.equal(
        extensionItems(items).length,
        0,
        `Expected no yak completion for an unsupported tag binding; received ${extensionItems(items).map(completionLabel).join(', ')}`,
      )
    }
  })

  await runCase('invalidates cached binding analysis after a document edit', async () => {
    const source = styledSource()
    const cursorOffset = source.indexOf(cursorMarker)
    const document = await vscode.workspace.openTextDocument({
      language: 'typescriptreact',
      content: source.replace(cursorMarker, ''),
    })

    const initialItems = await completionItemsAt(document, cursorOffset)
    assert.ok(
      findExtensionItem(initialItems, 'color'),
      'Expected a yak completion before removing the import',
    )

    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: true,
    })
    const importRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().indexOf('\n') + 1),
    )

    await editor.edit((edit) => edit.replace(importRange, "import { css } from 'next-yak'\n"))

    const updatedItems = await completionItemsAt(document, cursorOffset)
    assert.equal(
      extensionItems(updatedItems).length,
      0,
      `Expected no stale yak completions after removing the styled import; received ${extensionItems(updatedItems).map(completionLabel).join(', ')}`,
    )
  })

  await runCase(
    'provides mapped CSS hover documentation and excludes unsupported positions',
    async () => {
      const provider = await createDirectHoverProvider(extension.extensionPath)
      const requestFor = async (
        css: string,
        tag = 'styled.div',
        importStatement = "import { styled } from 'next-yak'",
      ) => {
        const request = await directProviderRequest(styledSource(css, tag, importStatement))

        return {
          ...request,
          hover: provider.provideHover(request.document, request.position, neverCancelledToken),
        }
      }

      const property = await requestFor('display/*cursor*/: grid;')
      assert.ok(property.hover, 'Expected a property hover')
      assert.ok(
        property.hover.contents[0] instanceof vscode.MarkdownString,
        'Expected CSS Markdown to become a VS Code MarkdownString',
      )
      assert.match(hoverContentText(property.hover), /MDN Reference/)
      assert.equal(property.document.getText(hoverRange(property.hover)), 'display: grid')

      const value = await requestFor('display: gr/*cursor*/id;')
      assert.ok(value.hover, 'Expected a value hover')
      assert.match(hoverContentText(value.hover), /grid formatting context/)
      assert.equal(value.document.getText(hoverRange(value.hover)), 'grid')

      const functionHover = await requestFor('transform: rot/*cursor*/ate(45deg);')
      assert.ok(functionHover.hover, 'Expected a function hover')
      assert.match(hoverContentText(functionHover.hover), /2D rotation/)
      assert.equal(functionHover.document.getText(hoverRange(functionHover.hover)), 'rotate')

      const pseudoClass = await requestFor('a:ho/*cursor*/ver { color: red; }')
      assert.ok(pseudoClass.hover, 'Expected a pseudo-class hover')
      assert.match(hoverContentText(pseudoClass.hover), /pointing device/)
      assert.equal(pseudoClass.document.getText(hoverRange(pseudoClass.hover)), ':hover')

      const pseudoElement = await requestFor('a::bef/*cursor*/ore { color: red; }')
      assert.ok(pseudoElement.hover, 'Expected a pseudo-element hover')
      assert.match(hoverContentText(pseudoElement.hover), /styleable child pseudo-element/)
      assert.equal(pseudoElement.document.getText(hoverRange(pseudoElement.hover)), '::before')

      const keyframes = await requestFor(
        'from { op/*cursor*/acity: 0; }',
        'keyframes',
        "import { keyframes } from 'next-yak'",
      )
      assert.ok(keyframes.hover, 'Expected a keyframes property hover')
      assert.match(hoverContentText(keyframes.hover), /MDN Reference/)

      const interpolation = await requestFor('color: ${theme./*cursor*/accent};')
      assert.equal(interpolation.hover, undefined)

      const invalid = await requestFor('@unknown/*cursor*/ rule;')
      assert.equal(invalid.hover, undefined)

      const registeredSource = styledSource('display/*cursor*/: grid;')
      const registeredRequest = await directProviderRequest(registeredSource)
      const registeredHovers = await registeredHoversAt(
        registeredRequest.document,
        registeredSource.indexOf(cursorMarker),
      )

      assert.ok(
        registeredHovers.some((hover) => hoverContentText(hover).includes('MDN Reference')),
        'Expected the activated extension to register a CSS HoverProvider',
      )
    },
  )

  await runCase(
    'surfaces mapped CSS diagnostics and filters interpolation-adjacent false positives',
    async () => {
      const source = [
        "import { styled } from 'next-yak'",
        'const Panel = styled.div`',
        '  color: ${theme.accent};',
        '  colro: red;',
        '`',
      ].join('\n')
      const document = await vscode.workspace.openTextDocument({
        language: 'typescriptreact',
        content: source,
      })

      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })
      const unknownProperty = diagnosticForText(document, 'colro')

      assert.ok(unknownProperty, 'Expected a mapped unknown-property diagnostic')
      assert.equal(unknownProperty.code, 'unknownProperties')
      assert.equal(unknownProperty.source, 'yak CSS')
      assert.equal(
        diagnosticForText(document, ';'),
        undefined,
        'Expected no empty-value diagnostic from the interpolation placeholder',
      )
    },
  )

  await runCase(
    'updates diagnostics after edits, language changes, close, and configuration changes',
    async () => {
      const source = [
        "import { styled } from 'next-yak'",
        'const Panel = styled.div`',
        '  colro: red;',
        '`',
      ].join('\n')
      const document = await vscode.workspace.openTextDocument({
        language: 'typescriptreact',
        content: source,
      })
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: true,
      })

      assert.ok(diagnosticForText(document, 'colro'), 'Expected initial CSS diagnostic')
      const typoStart = document.getText().indexOf('colro')
      await editor.edit((edit) =>
        edit.replace(
          new vscode.Range(document.positionAt(typoStart), document.positionAt(typoStart + 5)),
          'color',
        ),
      )
      assert.equal(
        diagnosticForText(document, 'color'),
        undefined,
        'Expected diagnostics to refresh after editing CSS',
      )

      await editor.edit((edit) =>
        edit.replace(
          new vscode.Range(document.positionAt(typoStart), document.positionAt(typoStart + 5)),
          'colro',
        ),
      )
      assert.ok(
        diagnosticForText(document, 'colro'),
        'Expected diagnostics to return after reintroducing the typo',
      )

      const configuration = vscode.workspace.getConfiguration('yak', document.uri)
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      const settingsDirectory =
        workspaceFolder && vscode.Uri.joinPath(workspaceFolder.uri, '.vscode')
      const settingsFile =
        settingsDirectory && vscode.Uri.joinPath(settingsDirectory, 'settings.json')
      const settingsDirectoryExisted = settingsDirectory
        ? await resourceExists(settingsDirectory)
        : true
      const settingsFileExisted = settingsFile ? await resourceExists(settingsFile) : true
      const previousWorkspaceValue = configuration.inspect<boolean>('css.validate')?.workspaceValue

      try {
        await configuration.update('css.validate', false, vscode.ConfigurationTarget.Workspace)
        assert.deepEqual(
          diagnosticsFor(document),
          [],
          'Expected CSS diagnostics to clear when validation is disabled',
        )
        await configuration.update('css.validate', true, vscode.ConfigurationTarget.Workspace)
        assert.ok(
          diagnosticForText(document, 'colro'),
          'Expected CSS diagnostics to return when validation is enabled',
        )

        const javascriptDocument = await vscode.languages.setTextDocumentLanguage(
          document,
          'javascript',
        )
        assert.ok(
          diagnosticForText(javascriptDocument, 'colro'),
          'Expected diagnostics after switching to another supported language',
        )
        const plaintextDocument = await vscode.languages.setTextDocumentLanguage(
          javascriptDocument,
          'plaintext',
        )
        assert.deepEqual(
          diagnosticsFor(plaintextDocument),
          [],
          'Expected diagnostics to clear after switching to an unsupported language',
        )

        const closeDocument = await vscode.workspace.openTextDocument({
          language: 'typescriptreact',
          content: source,
        })
        await vscode.window.showTextDocument(closeDocument, { preview: false, preserveFocus: true })
        assert.ok(
          diagnosticForText(closeDocument, 'colro'),
          'Expected a CSS diagnostic before closing a supported document',
        )
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
        assert.deepEqual(
          diagnosticsFor(closeDocument),
          [],
          'Expected no retained diagnostics after closing the document',
        )
      } finally {
        await configuration.update(
          'css.validate',
          previousWorkspaceValue,
          vscode.ConfigurationTarget.Workspace,
        )

        if (settingsFile && !settingsFileExisted && (await resourceExists(settingsFile))) {
          await vscode.workspace.fs.delete(settingsFile, { useTrash: false })
        }

        if (
          settingsDirectory &&
          !settingsDirectoryExisted &&
          (await resourceExists(settingsDirectory))
        ) {
          await vscode.workspace.fs.delete(settingsDirectory, { recursive: false, useTrash: false })
        }
      }
    },
  )

  await runCase(
    'offers a safe mapped CSS spelling quick fix and rejects interpolation fixes',
    async () => {
      const source = [
        "import { styled } from 'next-yak'",
        'const Panel = styled.div`',
        '  colro: red;',
        '  color: ${theme.accent};',
        '`',
      ].join('\n')
      const document = await vscode.workspace.openTextDocument({
        language: 'typescriptreact',
        content: source,
      })
      const typo = diagnosticForText(document, 'colro')

      assert.ok(typo, 'Expected a CSS spelling diagnostic before requesting code actions')
      const provider = await createDirectCodeActionProvider(extension.extensionPath)
      const directActions = provider.provideCodeActions(
        document,
        typo.range,
        {
          diagnostics: [typo],
          only: vscode.CodeActionKind.QuickFix,
          triggerKind: vscode.CodeActionTriggerKind.Invoke,
        },
        neverCancelledToken,
      )
      const directColorAction = directActions?.find(
        (action) => action.title === "Rename to 'color'",
      )

      assert.ok(
        directColorAction,
        'Expected the direct provider to return a Rename to color quick fix',
      )
      assert.ok(
        directColorAction.diagnostics?.some((diagnostic) => diagnostic.source === 'yak CSS'),
        'Expected the direct mapped action to reference its CSS diagnostic',
      )

      const actions = await registeredCodeActionsAt(document, typo.range)
      const colorAction = actions.find((action) => action.title === "Rename to 'color'")

      assert.ok(colorAction, 'Expected a mapped Rename to color quick fix')
      const edits = workspaceEditEntries(colorAction, document)
      assert.deepEqual(
        edits.map(([range, newText]) => [document.getText(range), newText]),
        [['colro', 'color']],
      )

      const interpolationOffset = source.indexOf('theme.accent')
      const interpolationRange = new vscode.Range(
        document.positionAt(interpolationOffset),
        document.positionAt(interpolationOffset + 'theme.accent'.length),
      )
      assert.deepEqual(
        provider.provideCodeActions(
          document,
          interpolationRange,
          {
            diagnostics: [],
            only: vscode.CodeActionKind.QuickFix,
            triggerKind: vscode.CodeActionTriggerKind.Invoke,
          },
          neverCancelledToken,
        ),
        [],
        'Expected the yak CSS provider to return no action within an interpolation',
      )
    },
  )

  await runCase(
    'keeps multiple CSS spelling fixes independent and skips diagnostics without fixes',
    async () => {
      const source = [
        "import { styled } from 'next-yak'",
        'const Panel = styled.div`',
        '  colro: red;',
        '  bakground: blue;',
        '  color: rgb(1, 2, 3;',
        '`',
      ].join('\n')
      const document = await vscode.workspace.openTextDocument({
        language: 'typescriptreact',
        content: source,
      })
      const colro = diagnosticForText(document, 'colro')
      const bakground = diagnosticForText(document, 'bakground')
      const unclosedValue = diagnosticForText(document, ';')
      const provider = await createDirectCodeActionProvider(extension.extensionPath)

      assert.ok(colro, 'Expected the first unknown-property diagnostic')
      assert.ok(bakground, 'Expected the second unknown-property diagnostic')
      assert.ok(unclosedValue, 'Expected an unclosed-value diagnostic')

      const colroActions =
        provider.provideCodeActions(
          document,
          colro.range,
          {
            diagnostics: [colro],
            only: vscode.CodeActionKind.QuickFix,
            triggerKind: vscode.CodeActionTriggerKind.Invoke,
          },
          neverCancelledToken,
        ) ?? []
      const colroAction = colroActions.find((action) => action.title === "Rename to 'color'")
      assert.ok(colroAction, 'Expected a color rename for colro')
      assert.deepEqual(
        workspaceEditEntries(colroAction, document).map(([range, newText]) => [
          document.getText(range),
          newText,
        ]),
        [['colro', 'color']],
      )

      const bakgroundActions =
        provider.provideCodeActions(
          document,
          bakground.range,
          {
            diagnostics: [bakground],
            only: vscode.CodeActionKind.QuickFix,
            triggerKind: vscode.CodeActionTriggerKind.Invoke,
          },
          neverCancelledToken,
        ) ?? []
      const bakgroundAction = bakgroundActions.find(
        (action) => action.title === "Rename to 'background'",
      )
      assert.ok(bakgroundAction, 'Expected a background rename for bakground')
      assert.deepEqual(
        workspaceEditEntries(bakgroundAction, document).map(([range, newText]) => [
          document.getText(range),
          newText,
        ]),
        [['bakground', 'background']],
      )

      assert.deepEqual(
        provider.provideCodeActions(
          document,
          unclosedValue.range,
          {
            diagnostics: [unclosedValue],
            only: vscode.CodeActionKind.QuickFix,
            triggerKind: vscode.CodeActionTriggerKind.Invoke,
          },
          neverCancelledToken,
        ),
        [],
        'Expected the yak CSS provider to return no quick fix when CSS Language Service does not offer one',
      )
    },
  )

  await runCase('provides safe mapped CSS colors and picker presentations', async () => {
    const source = [
      "import { styled } from 'next-yak'",
      'const Panel = styled.div`',
      '  color: #663399;',
      '  outline-color: rgba(23, 107, 91, 0.5);',
      '  border-color: rebeccapurple;',
      '  background: linear-gradient(#fff, hsl(160 45% 26%));',
      '  /* #ff0000 */',
      '  content: "#00ff00";',
      '  color: ${theme.accent};',
      '`',
    ].join('\n')
    const document = await vscode.workspace.openTextDocument({
      language: 'typescriptreact',
      content: source,
    })
    const provider = await createDirectColorProvider(extension.extensionPath)
    const directColors = provider.provideDocumentColors(document, neverCancelledToken)

    assert.ok(directColors, 'Expected the direct provider to find static CSS colors')
    assert.deepEqual(
      directColors.map((color) => document.getText(color.range)),
      ['#663399', 'rgba(23, 107, 91, 0.5)', 'rebeccapurple', '#fff', 'hsl(160 45% 26%)'],
    )
    const alphaColor = directColors.find(
      (color) => document.getText(color.range) === 'rgba(23, 107, 91, 0.5)',
    )
    const hexColor = directColors.find((color) => document.getText(color.range) === '#663399')

    assert.ok(alphaColor, 'Expected an alpha color decoration')
    assert.equal(alphaColor.color.alpha, 0.5)
    assert.ok(hexColor, 'Expected a static hex color decoration')

    const directPresentations = provider.provideColorPresentations(
      hexColor.color,
      { document, range: hexColor.range },
      neverCancelledToken,
    )

    assert.ok(directPresentations, 'Expected color picker presentations for the static hex color')
    assert.ok(
      directPresentations.some((presentation) => presentation.label === 'rgb(102, 51, 153)'),
    )
    assert.ok(
      directPresentations.some((presentation) => presentation.label === 'hsl(270, 50%, 40%)'),
    )
    const namedPresentation = directPresentations.find(
      (presentation) => presentation.label === 'rebeccapurple',
    )

    assert.ok(namedPresentation?.textEdit, 'Expected an exact named-color presentation')
    assert.equal(document.getText(namedPresentation.textEdit.range), '#663399')
    assert.equal(namedPresentation.textEdit.newText, 'rebeccapurple')

    const alphaPresentations = provider.provideColorPresentations(
      alphaColor.color,
      { document, range: alphaColor.range },
      neverCancelledToken,
    )

    assert.ok(alphaPresentations, 'Expected color picker presentations for the alpha color')
    const rgbaPresentation = alphaPresentations.find(
      (presentation) => presentation.label === 'rgba(23, 107, 91, 0.5)',
    )
    const hslaPresentation = alphaPresentations.find(
      (presentation) => presentation.label === 'hsla(169, 65%, 25%, 0.5)',
    )

    assert.ok(
      rgbaPresentation?.textEdit,
      'Expected an rgba picker presentation for the alpha color',
    )
    assert.ok(
      hslaPresentation?.textEdit,
      'Expected an hsla picker presentation for the alpha color',
    )
    assert.equal(document.getText(rgbaPresentation.textEdit.range), 'rgba(23, 107, 91, 0.5)')
    assert.equal(document.getText(hslaPresentation.textEdit.range), 'rgba(23, 107, 91, 0.5)')
    assert.ok(!alphaPresentations.some((presentation) => presentation.label === 'rebeccapurple'))

    const commentStart = source.indexOf('#ff0000')
    const commentRange = new vscode.Range(
      document.positionAt(commentStart),
      document.positionAt(commentStart + '#ff0000'.length),
    )

    assert.deepEqual(
      provider.provideColorPresentations(
        new vscode.Color(1, 0, 0, 1),
        { document, range: commentRange },
        neverCancelledToken,
      ),
      [],
      'Expected no color picker presentation for a comment pseudo-color',
    )

    const registeredColors = await registeredDocumentColors(document)
    const registeredHexColor = registeredColors.find(
      (color) => document.getText(color.range) === '#663399',
    )

    assert.ok(
      registeredHexColor,
      'Expected the activated extension to register a DocumentColorProvider',
    )
    const registeredPresentations = await registeredColorPresentations(
      document,
      registeredHexColor.color,
      registeredHexColor.range,
    )
    const registeredNamedPresentation = registeredPresentations.find(
      (presentation) => presentation.label === 'rebeccapurple',
    )

    assert.ok(
      registeredNamedPresentation?.textEdit,
      'Expected the registered picker to offer rebeccapurple',
    )
    assert.equal(document.getText(registeredNamedPresentation.textEdit.range), '#663399')
  })

  await runCase(
    'keeps completion ranges safe for incomplete templates and syntax errors',
    async () => {
      const incompleteTemplate = await assertPropertyCompletion({
        source: [
          "import { styled } from 'next-yak'",
          'const Panel = styled.div`',
          `  col${cursorMarker}`,
        ].join('\n'),
      })
      assertRangeWithinDocument(incompleteTemplate.document, incompleteTemplate.item)

      const malformedTsx = await assertPropertyCompletion({
        source: [
          "import { styled } from 'next-yak'",
          'const view = <section>',
          '  {styled.div`',
          `    col${cursorMarker}`,
          '  `}',
        ].join('\n'),
      })
      assertRangeWithinDocument(malformedTsx.document, malformedTsx.item)

      const interpolation = await completionItems({
        source: [
          "import { styled } from 'next-yak'",
          'const Panel = styled.div`',
          `  color: \${({ theme }) => theme.${cursorMarker}`,
        ].join('\n'),
      })
      assert.equal(
        extensionItems(interpolation.items).length,
        0,
        `Expected interpolation completion to remain with the host language service; received ${extensionItems(interpolation.items).map(completionLabel).join(', ')}`,
      )
    },
  )

  await runCase('works for unsaved and virtual read-only remote-style documents', async () => {
    const unsaved = await assertPropertyCompletion({ source: styledSource() })
    assert.equal(unsaved.document.uri.scheme, 'untitled')
    assert.equal(unsaved.document.isUntitled, true)

    const scheme = 'yak-test'
    const virtualSource = styledSource().replace(cursorMarker, '')
    const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent: () => virtualSource,
    })

    try {
      for (const uri of [
        vscode.Uri.parse(`${scheme}://readonly/Panel.tsx`),
        vscode.Uri.from({ scheme, authority: 'ssh-remote+fixture', path: '/workspace/Panel.tsx' }),
      ]) {
        const { document, item } = await assertPropertyCompletion({
          source: styledSource(),
          uri,
        })
        assert.equal(document.isUntitled, false)
        assert.equal(document.isDirty, false)
        assertRangeWithinDocument(document, item)
      }
    } finally {
      provider.dispose()
    }
  })

  await runCase('keeps completion requests independent across multiple cursors', async () => {
    const source = [
      "import { styled } from 'next-yak'",
      'const Panel = styled.div`',
      '  col',
      '  dis',
      '`',
    ].join('\n')
    const document = await vscode.workspace.openTextDocument({
      language: 'typescriptreact',
      content: source,
    })
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: true,
    })
    const colorOffset = source.indexOf('col') + 'col'.length
    const displayOffset = source.indexOf('dis') + 'dis'.length
    const provider = await createDirectProvider(extension.extensionPath)

    editor.selections = [
      new vscode.Selection(document.positionAt(colorOffset), document.positionAt(colorOffset)),
      new vscode.Selection(document.positionAt(displayOffset), document.positionAt(displayOffset)),
    ]

    const colorItems =
      provider.provideCompletionItems(
        document,
        document.positionAt(colorOffset),
        neverCancelledToken,
      )?.items ?? []
    const displayItems =
      provider.provideCompletionItems(
        document,
        document.positionAt(displayOffset),
        neverCancelledToken,
      )?.items ?? []
    const color = findExtensionItem(colorItems, 'color')
    const display = findExtensionItem(displayItems, 'display')

    assert.ok(color, 'Expected color completion at the first cursor')
    assert.ok(display, 'Expected display completion at the second cursor')
    assert.equal(document.getText(completionRange(color)), 'col')
    assert.equal(document.getText(completionRange(display)), 'dis')
  })

  await runCase('keeps completion current through rapid edits, undo, and redo', async () => {
    const source = styledSource('col')
    const initialOffset = source.indexOf(cursorMarker)
    const document = await vscode.workspace.openTextDocument({
      language: 'typescriptreact',
      content: source.replace(cursorMarker, ''),
    })
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: true,
    })
    const provider = await createDirectProvider(extension.extensionPath)
    const propertyStart = document.getText().indexOf('col')
    let prefix = 'col'

    for (const nextPrefix of ['c', 'co', 'col', 'colo', 'col']) {
      await editor.edit((edit) =>
        edit.replace(
          new vscode.Range(
            document.positionAt(propertyStart),
            document.positionAt(propertyStart + prefix.length),
          ),
          nextPrefix,
        ),
      )
      prefix = nextPrefix
      const items =
        provider.provideCompletionItems(
          document,
          document.positionAt(propertyStart + prefix.length),
          neverCancelledToken,
        )?.items ?? []
      const color = findExtensionItem(items, 'color')

      assert.ok(color, `Expected color completion after rapidly editing to ${prefix}`)
      assert.equal(document.getText(completionRange(color)), prefix)
    }

    await editor.edit((edit) =>
      edit.replace(
        new vscode.Range(
          document.positionAt(propertyStart),
          document.positionAt(propertyStart + prefix.length),
        ),
        'display: g',
      ),
    )
    const displayValueOffset = propertyStart + 'display: g'.length
    let items =
      provider.provideCompletionItems(
        document,
        document.positionAt(displayValueOffset),
        neverCancelledToken,
      )?.items ?? []

    assert.ok(
      findExtensionItem(items, 'grid'),
      'Expected grid completion after editing the declaration value',
    )
    await vscode.commands.executeCommand('undo')
    assert.equal(
      document.getText().indexOf('col'),
      propertyStart,
      'Expected undo to restore the property prefix',
    )
    items =
      provider.provideCompletionItems(
        document,
        document.positionAt(initialOffset),
        neverCancelledToken,
      )?.items ?? []
    assert.ok(findExtensionItem(items, 'color'), 'Expected color completion after undo')

    await vscode.commands.executeCommand('redo')
    assert.ok(
      document.getText().includes('display: g'),
      'Expected redo to restore the declaration value',
    )
    items =
      provider.provideCompletionItems(
        document,
        document.positionAt(displayValueOffset),
        neverCancelledToken,
      )?.items ?? []
    assert.ok(findExtensionItem(items, 'grid'), 'Expected grid completion after redo')
  })

  await runCase('stops cancelled completion work before and after CSS computation', async () => {
    const provider = await createDirectProvider(extension.extensionPath)
    const request = await directProviderRequest(styledSource())
    const atRuleRequest = await directProviderRequest(atRuleSource('@med'))

    assert.equal(
      provider.provideCompletionItems(request.document, request.position, cancellationToken(1)),
      undefined,
      'Expected an already cancelled request to return immediately',
    )
    assert.equal(
      provider.provideCompletionItems(request.document, request.position, cancellationToken(2)),
      undefined,
      'Expected a request cancelled after CSS computation to discard stale items',
    )
    assert.equal(
      provider.provideCompletionItems(
        atRuleRequest.document,
        atRuleRequest.position,
        cancellationToken(2),
      ),
      undefined,
      'Expected an at-rule request cancelled after CSS computation to discard stale items',
    )

    const cancellationSource = new vscode.CancellationTokenSource()
    const cancelsDuringCssCompletion: CssCompletionService = {
      doComplete: () => ({ isIncomplete: false, items: [] }),
      parseStylesheet: () => {
        cancellationSource.cancel()
        return {}
      },
    }
    const cancellableProvider = await createDirectProvider(
      extension.extensionPath,
      cancelsDuringCssCompletion,
    )

    try {
      assert.equal(
        cancellableProvider.provideCompletionItems(
          request.document,
          request.position,
          cancellationSource.token,
        ),
        undefined,
        'Expected a real cancellation token to discard completion after CSS work begins',
      )
    } finally {
      cancellationSource.dispose()
    }
  })

  await runCase('degrades safely when CSS completion responses are malformed', async () => {
    const malformedService: CssCompletionService = {
      doComplete: () =>
        ({
          items: [
            undefined,
            { label: 42 },
            { label: 'unsafe', textEdit: { newText: 'unsafe', range: null } },
            { label: 'safe' },
          ],
        }) as unknown as CssCompletionList,
      parseStylesheet: () => ({}),
    }
    const provider = await createDirectProvider(extension.extensionPath, malformedService)
    const request = await directProviderRequest(styledSource(''))
    const items =
      provider.provideCompletionItems(request.document, request.position, neverCancelledToken)
        ?.items ?? []

    assert.deepEqual(extensionItems(items).map(completionLabel), ['safe'])
  })

  await runCase(
    'degrades safely when corrupt CSS custom data throws during completion',
    async () => {
      const corruptCustomData = {
        properties: [{ name: '--broken', values: [{ name: null }] }],
        version: 1.1,
      } as unknown as CSSDataV1
      const corruptDataService = getCSSLanguageService({
        customDataProviders: [newCSSDataProvider(corruptCustomData)],
      })
      const provider = await createDirectProvider(extension.extensionPath, corruptDataService)
      const request = await directProviderRequest(styledSource('--broken: '))
      const items =
        provider.provideCompletionItems(request.document, request.position, neverCancelledToken)
          ?.items ?? []

      assert.deepEqual(extensionItems(items), [])
    },
  )

  await runCase('keeps completion latency within the defined budgets', async () => {
    const provider = await createDirectProvider(extension.extensionPath)
    const singleCharacterRequest = await directProviderRequest(styledSource('c'))
    let startedAt = performance.now()
    let result = provider.provideCompletionItems(
      singleCharacterRequest.document,
      singleCharacterRequest.position,
      neverCancelledToken,
    )
    let elapsedMilliseconds = performance.now() - startedAt

    assert.ok(
      result?.items.some((item) => completionLabel(item) === 'color'),
      'Expected color for a single-character request',
    )
    assert.ok(
      elapsedMilliseconds < completionLatencyBudgetMilliseconds.singleCharacter,
      `Expected single-character completion under ${completionLatencyBudgetMilliseconds.singleCharacter}ms; took ${elapsedMilliseconds.toFixed(1)}ms`,
    )

    const manualSource = styledSource('col')
    const manualCursorOffset = manualSource.indexOf(cursorMarker)
    const manualDocument = await vscode.workspace.openTextDocument({
      language: 'typescriptreact',
      content: manualSource.replace(cursorMarker, ''),
    })
    await vscode.window.showTextDocument(manualDocument, { preview: false, preserveFocus: true })
    startedAt = performance.now()
    const manualList = await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
      'vscode.executeCompletionItemProvider',
      manualDocument.uri,
      manualDocument.positionAt(manualCursorOffset),
    )
    elapsedMilliseconds = performance.now() - startedAt

    assert.ok(
      findExtensionItem(manualList?.items ?? [], 'color'),
      'Expected color from manual completion',
    )
    assert.ok(
      elapsedMilliseconds < completionLatencyBudgetMilliseconds.manualTrigger,
      `Expected manual completion under ${completionLatencyBudgetMilliseconds.manualTrigger}ms; took ${elapsedMilliseconds.toFixed(1)}ms`,
    )

    const continuousSource = styledSource('c')
    const continuousDocument = await vscode.workspace.openTextDocument({
      language: 'typescriptreact',
      content: continuousSource.replace(cursorMarker, ''),
    })
    const continuousEditor = await vscode.window.showTextDocument(continuousDocument, {
      preview: false,
      preserveFocus: true,
    })
    const continuousPrefixStart = continuousDocument.getText().lastIndexOf('  c') + 2
    let continuousPrefix = 'c'

    startedAt = performance.now()
    for (const nextPrefix of ['c', 'co', 'col', 'colo', 'color']) {
      if (nextPrefix !== continuousPrefix) {
        await continuousEditor.edit((edit) =>
          edit.replace(
            new vscode.Range(
              continuousDocument.positionAt(continuousPrefixStart),
              continuousDocument.positionAt(continuousPrefixStart + continuousPrefix.length),
            ),
            nextPrefix,
          ),
        )
        continuousPrefix = nextPrefix
      }

      result = provider.provideCompletionItems(
        continuousDocument,
        continuousDocument.positionAt(continuousPrefixStart + continuousPrefix.length),
        neverCancelledToken,
      )
      assert.ok(
        result?.items.some((item) => completionLabel(item) === 'color'),
        `Expected color during continuous input at ${continuousPrefix}`,
      )
    }
    elapsedMilliseconds = performance.now() - startedAt

    assert.ok(
      elapsedMilliseconds < completionLatencyBudgetMilliseconds.continuousInput,
      `Expected continuous completion under ${completionLatencyBudgetMilliseconds.continuousInput}ms; took ${elapsedMilliseconds.toFixed(1)}ms`,
    )

    const largeSource = [
      "import { styled } from 'next-yak'",
      ...Array.from(
        { length: largeDocumentTemplateCount },
        (_, index) => `const Panel${index} = styled.div\`color: red;\``,
      ),
      'const Current = styled.div`',
      `  col${cursorMarker}`,
      '`',
    ].join('\n')
    const largeRequest = await directProviderRequest(largeSource)
    startedAt = performance.now()
    result = provider.provideCompletionItems(
      largeRequest.document,
      largeRequest.position,
      neverCancelledToken,
    )
    elapsedMilliseconds = performance.now() - startedAt

    assert.ok(
      result?.items.some((item) => completionLabel(item) === 'color'),
      'Expected color in a large document',
    )
    assert.ok(
      elapsedMilliseconds < completionLatencyBudgetMilliseconds.largeDocument,
      `Expected completion across ${largeDocumentTemplateCount} templates under ${completionLatencyBudgetMilliseconds.largeDocument}ms; took ${elapsedMilliseconds.toFixed(1)}ms`,
    )
  })
}
