import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as vscode from 'vscode'

const cursorMarker = '/*cursor*/'
const nextYakSortPrefix = '!'

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
  new (): DirectCompletionProvider
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

interface ExtensionModule {
  NextYakCssCompletionProvider?: DirectCompletionProviderConstructor
  NextYakCssHoverProvider?: DirectHoverProviderConstructor
  default?: {
    NextYakCssCompletionProvider?: DirectCompletionProviderConstructor
    NextYakCssHoverProvider?: DirectHoverProviderConstructor
  }
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

function nextYakItems(items: readonly vscode.CompletionItem[]): vscode.CompletionItem[] {
  return items.filter((item) => item.sortText?.startsWith(nextYakSortPrefix))
}

function findNextYakItem(items: readonly vscode.CompletionItem[], label: string): vscode.CompletionItem | undefined {
  return nextYakItems(items).find((item) => completionLabel(item) === label)
}

function assertRangeWithinDocument(document: vscode.TextDocument, item: vscode.CompletionItem): void {
  const range = completionRange(item)
  const start = document.offsetAt(range.start)
  const end = document.offsetAt(range.end)

  assert.ok(start >= 0, `Expected ${completionLabel(item)} range to start inside the document`)
  assert.ok(end >= start, `Expected ${completionLabel(item)} range to be ordered`)
  assert.ok(end <= document.getText().length, `Expected ${completionLabel(item)} range to end inside the document`)
}

async function completionItems({ language = 'typescriptreact', source, uri }: CompletionOptions): Promise<CompletionResult> {
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
  const item = findNextYakItem(items, expectedLabel)

  assert.ok(item, `Expected next-yak ${expectedLabel} completion in ${nextYakItems(items).map(completionLabel).join(', ')}`)
  assertRangeWithinDocument(document, item)
  return { document, item, items }
}

async function assertPseudoCompletion(selector: string, expectedLabel: string, expectedInsertText: string): Promise<void> {
  const { document, items } = await completionItems({
    source: [
      "import { styled } from 'next-yak'",
      'const Link = styled.a`',
      `  ${selector}${cursorMarker}`,
      '`',
    ].join('\n'),
  })
  const item = findNextYakItem(items, expectedLabel)

  assert.ok(item, `Expected ${expectedLabel} in ${nextYakItems(items).map(completionLabel).join(', ')}`)
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
  const item = findNextYakItem(items, expectedLabel)

  assert.ok(item, `Expected next-yak ${expectedLabel} completion in ${nextYakItems(items).map(completionLabel).join(', ')}`)
  assertRangeWithinDocument(document, item)
  assert.equal(document.getText(completionRange(item)), expectedReplacement)
  assert.equal(completionInsertText(item), expectedInsertText)

  return { document, item, items }
}

async function assertNoPseudoFallback(source: string): Promise<void> {
  const { items } = await completionItems({ source })
  const pseudoLabels = nextYakItems(items)
    .map(completionLabel)
    .filter((label) => label.startsWith(':'))

  assert.deepEqual(pseudoLabels, [], `Expected no next-yak pseudo fallback, received ${pseudoLabels.join(', ')}`)
}

async function assertNoAtRuleCompletion(source: string): Promise<void> {
  const { items } = await completionItems({ source })
  const atRuleLabels = nextYakItems(items)
    .map(completionLabel)
    .filter((label) => label.startsWith('@'))

  assert.deepEqual(atRuleLabels, [], `Expected no next-yak at-rule completion, received ${atRuleLabels.join(', ')}`)
}

async function assertNoNextYakCompletion(source: string): Promise<void> {
  const { items } = await completionItems({ source })
  const labels = nextYakItems(items).map(completionLabel)

  assert.deepEqual(labels, [], `Expected no next-yak completion, received ${labels.join(', ')}`)
}

async function runCase(name: string, callback: () => Promise<void>): Promise<void> {
  try {
    await callback()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${name}: ${message}`, { cause: error })
  }
}

async function createDirectProvider(extensionPath: string): Promise<DirectCompletionProvider> {
  const extensionModule = await import(pathToFileURL(join(extensionPath, 'dist', 'extension.cjs')).href) as ExtensionModule
  const Provider = extensionModule.NextYakCssCompletionProvider ?? extensionModule.default?.NextYakCssCompletionProvider

  assert.ok(Provider, 'Expected the extension bundle to export NextYakCssCompletionProvider')
  return new Provider()
}

async function createDirectHoverProvider(extensionPath: string): Promise<DirectHoverProvider> {
  const extensionModule = await import(pathToFileURL(join(extensionPath, 'dist', 'extension.cjs')).href) as ExtensionModule
  const Provider = extensionModule.NextYakCssHoverProvider ?? extensionModule.default?.NextYakCssHoverProvider

  assert.ok(Provider, 'Expected the extension bundle to export NextYakCssHoverProvider')
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

async function directProviderRequest(source: string, language = 'typescriptreact'): Promise<{
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

async function completionItemsAt(document: vscode.TextDocument, cursorOffset: number): Promise<readonly vscode.CompletionItem[]> {
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
    .map((content) => typeof content === 'string' ? content : content.value)
    .join('\n')
}

function hoverRange(hover: vscode.Hover): vscode.Range {
  if (!hover.range) {
    throw new Error('Expected hover to define a source replacement range')
  }

  return hover.range
}

async function registeredHoversAt(document: vscode.TextDocument, cursorOffset: number): Promise<readonly vscode.Hover[]> {
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })

  return vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    document.uri,
    document.positionAt(cursorOffset),
  )
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('local.next-yak-vscode')

  assert.ok(extension, 'The next-yak extension should be available in the Extension Development Host')
  await extension.activate()

  await runCase('completes CSS properties in every supported host language', async () => {
    for (const language of ['javascript', 'javascriptreact', 'typescript', 'typescriptreact']) {
      await assertPropertyCompletion({ language, source: styledSource() })
    }
  })

  await runCase('completes supported next-yak tagged template forms', async () => {
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

  await runCase('does not use pseudo fallback in declaration and at-rule contexts', async () => {
    const sourceForLine = (line: string): string => [
      "import { styled } from 'next-yak'",
      'const Panel = styled.div`',
      `  ${line}${cursorMarker}`,
      '`',
    ].join('\n')

    await assertNoPseudoFallback(sourceForLine('unknown: value'))
    await assertNoPseudoFallback(sourceForLine('color: re'))
    await assertNoPseudoFallback(sourceForLine('@media '))
    await assertNoNextYakCompletion(sourceForLine('@media '))
    await assertNoPseudoFallback(sourceForLine('--accent:'))
  })

  await runCase('completes standard at-rule names with safe replacement ranges', async () => {
    const root = await assertAtRuleCompletion(atRuleSource('@'), '@media', '@')
    const rootLabels = new Set(nextYakItems(root.items).map(completionLabel))

    for (const label of [
      '@media',
      '@supports',
      '@container',
      '@layer',
      '@scope',
      '@keyframes',
    ]) {
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
    const globalLabels = new Set(nextYakItems(global.items).map(completionLabel))

    for (const label of ['@font-face', '@property', '@counter-style', '@page']) {
      assert.ok(globalLabels.has(label), `Expected ${label} in globalStyle at-rule candidates`)
    }
    for (const label of ['@charset', '@import', '@namespace']) {
      assert.ok(!globalLabels.has(label), `Expected ${label} to remain unavailable in a tagged template`)
    }
  })

  await runCase('keeps at-rule completions scoped to valid names and nested rule bodies', async () => {
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
      nextYakItems(nested.items)
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
      nextYakItems(descriptor.items)
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
      nextYakItems(fontFace.items)
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
  })

  await runCase('rejects type-only, locally shadowed, and dynamic next-yak tags', async () => {
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
        nextYakItems(items).length,
        0,
        `Expected no next-yak completion for an unsupported tag binding; received ${nextYakItems(items).map(completionLabel).join(', ')}`,
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
    assert.ok(findNextYakItem(initialItems, 'color'), 'Expected a next-yak completion before removing the import')

    const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })
    const importRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().indexOf('\n') + 1))

    await editor.edit((edit) => edit.replace(importRange, "import { css } from 'next-yak'\n"))

    const updatedItems = await completionItemsAt(document, cursorOffset)
    assert.equal(
      nextYakItems(updatedItems).length,
      0,
      `Expected no stale next-yak completions after removing the styled import; received ${nextYakItems(updatedItems).map(completionLabel).join(', ')}`,
    )
  })

  await runCase('provides mapped CSS hover documentation and excludes unsupported positions', async () => {
    const provider = await createDirectHoverProvider(extension.extensionPath)
    const requestFor = async (css: string, tag = 'styled.div', importStatement = "import { styled } from 'next-yak'") => {
      const request = await directProviderRequest(styledSource(css, tag, importStatement))

      return {
        ...request,
        hover: provider.provideHover(request.document, request.position, neverCancelledToken),
      }
    }

    const property = await requestFor('display/*cursor*/: grid;')
    assert.ok(property.hover, 'Expected a property hover')
    assert.ok(property.hover.contents[0] instanceof vscode.MarkdownString, 'Expected CSS Markdown to become a VS Code MarkdownString')
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

    const keyframes = await requestFor('from { op/*cursor*/acity: 0; }', 'keyframes', "import { keyframes } from 'next-yak'")
    assert.ok(keyframes.hover, 'Expected a keyframes property hover')
    assert.match(hoverContentText(keyframes.hover), /MDN Reference/)

    const interpolation = await requestFor('color: ${theme./*cursor*/accent};')
    assert.equal(interpolation.hover, undefined)

    const invalid = await requestFor('@unknown/*cursor*/ rule;')
    assert.equal(invalid.hover, undefined)

    const registeredSource = styledSource('display/*cursor*/: grid;')
    const registeredRequest = await directProviderRequest(registeredSource)
    const registeredHovers = await registeredHoversAt(registeredRequest.document, registeredSource.indexOf(cursorMarker))

    assert.ok(
      registeredHovers.some((hover) => hoverContentText(hover).includes('MDN Reference')),
      'Expected the activated extension to register a CSS HoverProvider',
    )
  })

  await runCase('keeps completion ranges safe for incomplete templates and syntax errors', async () => {
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
      nextYakItems(interpolation.items).length,
      0,
      `Expected interpolation completion to remain with the host language service; received ${nextYakItems(interpolation.items).map(completionLabel).join(', ')}`,
    )
  })

  await runCase('works for unsaved and virtual read-only remote-style documents', async () => {
    const unsaved = await assertPropertyCompletion({ source: styledSource() })
    assert.equal(unsaved.document.uri.scheme, 'untitled')
    assert.equal(unsaved.document.isUntitled, true)

    const scheme = 'next-yak-test'
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
      provider.provideCompletionItems(atRuleRequest.document, atRuleRequest.position, cancellationToken(2)),
      undefined,
      'Expected an at-rule request cancelled after CSS computation to discard stale items',
    )
  })

  await runCase('keeps a large document responsive during continuous completion requests', async () => {
    const provider = await createDirectProvider(extension.extensionPath)
    const templateCount = 80
    const source = [
      "import { styled } from 'next-yak'",
      ...Array.from({ length: templateCount }, (_, index) => `const Panel${index} = styled.div\`color: red;\``),
      'const Current = styled.div`',
      `  col${cursorMarker}`,
      '`',
    ].join('\n')
    const startedAt = performance.now()

    for (const prefix of ['c', 'co', 'col', 'colo', 'color']) {
      const request = await directProviderRequest(source.replace('col/*cursor*/', `${prefix}/*cursor*/`))
      const result = provider.provideCompletionItems(request.document, request.position, neverCancelledToken)

      assert.ok(result?.items.some((item) => completionLabel(item) === 'color'), `Expected color during continuous input at ${prefix}`)
    }

    const elapsedMilliseconds = performance.now() - startedAt
    assert.ok(
      elapsedMilliseconds < 5_000,
      `Expected five completion requests across ${templateCount} templates to finish under 5000ms; took ${elapsedMilliseconds.toFixed(1)}ms`,
    )
  })
}
