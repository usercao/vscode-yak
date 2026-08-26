import { posix } from 'node:path'

import * as vscode from 'vscode'

import {
  findCssCustomPropertyAtOffset,
  isCssTextOffsetProtected,
  isProjectIndexablePath,
  ProjectCssIndex,
  type IndexedCssCustomProperty,
  type IndexedCssMixin,
  type ProjectIndexDocument,
} from './projectIndex'
import { isOffsetInRange, TemplateCache, type Template } from './template'
import {
  getTemplateLibraryProfiles,
  templateLibraryIds,
  type TemplateLibraryProfile,
} from './templateLibraries'

const projectIndexFilePattern = '**/*.{css,js,jsx,ts,tsx}'
const projectIndexExcludePattern =
  '**/{.git,.next,.vscode-test,build,coverage,dist,node_modules}/**'
const projectIndexDocumentUpdateDelayMilliseconds = 150
const projectIndexMaxFileBytes = 512 * 1024
const projectIndexMaxFiles = 2_000
const projectIndexMaxTotalBytes = 16 * 1024 * 1024
const hostLanguageIds = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact'])
const excludedProjectPathExpression =
  /(?:^|\/)(?:\.git|\.next|\.vscode-test|build|coverage|dist|node_modules)(?:\/|$)/
const textEncoder = new TextEncoder()

export interface ProjectCssIndexRuntime extends vscode.Disposable {
  readonly whenReady: Promise<void>
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionList | undefined>
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Definition | undefined>
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined>
  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined>
  start(): void
}

interface StaticCssTemplateContext {
  kind: 'static'
  template: Template
}

interface TemplateInterpolationContext {
  interpolationStart: number
  kind: 'interpolation'
  template: Template
}

type TemplateContext = StaticCssTemplateContext | TemplateInterpolationContext

interface MixinCompletionContext {
  prefix: string
  range: vscode.Range
}

type ProjectIndexLimitReason = 'file-count' | 'file-size' | 'total-size'

export function createProjectCssIndexRuntime(): ProjectCssIndexRuntime {
  return new WorkspaceProjectCssIndexRuntime()
}

class WorkspaceProjectCssIndexRuntime implements ProjectCssIndexRuntime {
  private readonly indexedFileSizes = new Map<string, number>()
  private readonly index = new ProjectCssIndex()
  private readonly pendingDocumentUpdates = new Map<string, vscode.TextDocument>()
  private readonly pendingUriUpdates = new Map<string, vscode.Uri>()
  private readonly ready: Promise<void>
  private readonly statusBarItem = vscode.window.createStatusBarItem(
    'yak.projectIndex',
    vscode.StatusBarAlignment.Right,
    10,
  )
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly templateCache = new TemplateCache()
  private hasFinishedInitialScan = false
  private indexedTotalBytes = 0
  private isDisposed = false
  private isLimited = false
  private limitReason: ProjectIndexLimitReason | undefined
  private isStarted = false
  private pendingUpdateTimer: ReturnType<typeof setTimeout> | undefined
  private resolveReady!: () => void
  private scanCancellation: vscode.CancellationTokenSource | undefined
  private scanGeneration = 0

  constructor() {
    this.ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve
    })
    this.statusBarItem.tooltip = `Yak indexes up to ${projectIndexMaxFiles.toLocaleString()} CSS, JS, and TS files for project CSS tokens and mixins.`

    const watcher = vscode.workspace.createFileSystemWatcher(projectIndexFilePattern)

    this.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => this.queueUriUpdate(uri)),
      watcher.onDidChange((uri) => this.queueUriUpdate(uri)),
      watcher.onDidDelete((uri) => this.deleteUri(uri)),
      vscode.workspace.onDidChangeTextDocument((event) => this.queueDocumentUpdate(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.restoreClosedDocument(document)),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const file of event.files) {
          void this.handleRename(file.oldUri, file.newUri)
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.restart()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('yak.templateLibraries')) {
          this.restart()
        }
      }),
    )
  }

  get whenReady(): Promise<void> {
    return this.ready
  }

  dispose(): void {
    if (this.isDisposed) {
      return
    }

    this.isDisposed = true
    this.scanCancellation?.cancel()
    this.scanCancellation?.dispose()

    if (this.pendingUpdateTimer !== undefined) {
      clearTimeout(this.pendingUpdateTimer)
    }

    this.pendingDocumentUpdates.clear()
    this.pendingUriUpdates.clear()
    this.indexedFileSizes.clear()
    this.indexedTotalBytes = 0
    this.index.clear()
    this.templateCache.clear()
    this.statusBarItem.dispose()
    this.subscriptions.forEach((subscription) => subscription.dispose())
    this.finishInitialScan()
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionList | undefined> {
    if (token.isCancellationRequested || !isHostDocument(document)) {
      return undefined
    }

    const offset = document.offsetAt(position)
    const context = this.getTemplateContext(document, offset)

    if (!context || token.isCancellationRequested) {
      return undefined
    }

    const customPropertyContext =
      context.kind === 'static'
        ? getCustomPropertyCompletionContext(
            context.template.maskedBody,
            offset - context.template.bodyStart,
          )
        : undefined
    const mixinContext =
      context.kind === 'interpolation'
        ? this.getMixinCompletionContext(document, offset, context)
        : undefined

    if (!customPropertyContext && !mixinContext) {
      return undefined
    }

    this.start()
    this.indexTextDocument(document)
    await this.flushPendingUpdates()

    if (!(await this.waitForInitialIndex(token))) {
      return undefined
    }

    return customPropertyContext
      ? this.getCustomPropertyCompletions(document, offset, customPropertyContext, token)
      : mixinContext
        ? this.getMixinCompletions(document, mixinContext, token)
        : undefined
  }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Definition | undefined> {
    const tokenAtPosition = this.getCustomPropertyAtPosition(document, position)

    if (!tokenAtPosition || token.isCancellationRequested) {
      return undefined
    }

    this.start()
    this.indexTextDocument(document)
    await this.flushPendingUpdates()

    if (!(await this.waitForInitialIndex(token))) {
      return undefined
    }

    const definitions = this.index.getDefinitions(
      tokenAtPosition.name,
      document.uri.toString(),
      (fromUri, specifier) => this.resolveCssImport(fromUri, specifier),
    )

    return this.toLocations(definitions, token)
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const tokenAtPosition = this.getCustomPropertyAtPosition(document, position)

    if (!tokenAtPosition || token.isCancellationRequested) {
      return undefined
    }

    this.start()
    this.indexTextDocument(document)
    await this.flushPendingUpdates()

    if (!(await this.waitForInitialIndex(token))) {
      return undefined
    }

    const definitions = this.index.getDefinitions(
      tokenAtPosition.name,
      document.uri.toString(),
      (fromUri, specifier) => this.resolveCssImport(fromUri, specifier),
    )
    const firstDefinition = definitions[0]

    if (!firstDefinition) {
      return undefined
    }

    const contents = new vscode.MarkdownString()
    const sourceLabel = definitions.length === 1 ? 'Defined in' : 'Preferred definition in'

    contents.appendMarkdown(`**${escapeMarkdown(tokenAtPosition.name)}**\n\n`)
    contents.appendMarkdown(`${sourceLabel} \`${escapeMarkdown(firstDefinition.relativePath)}\`.`)

    if (definitions.length > 1) {
      contents.appendMarkdown(
        `\n\n${definitions.length - 1} additional definition(s) are available.`,
      )
    }

    return new vscode.Hover(
      contents,
      new vscode.Range(
        document.positionAt(tokenAtPosition.start),
        document.positionAt(tokenAtPosition.end),
      ),
    )
  }

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    const tokenAtPosition = this.getCustomPropertyAtPosition(document, position)

    if (!tokenAtPosition || token.isCancellationRequested) {
      return undefined
    }

    this.start()
    this.indexTextDocument(document)
    await this.flushPendingUpdates()

    if (!(await this.waitForInitialIndex(token))) {
      return undefined
    }

    return this.toLocations(
      this.index.getReferences(tokenAtPosition.name, context.includeDeclaration),
      token,
    )
  }

  start(): void {
    if (this.isDisposed || this.isStarted) {
      return
    }

    this.isStarted = true
    this.restart()
  }

  private deleteUri(uri: vscode.Uri): void {
    if (!this.isStarted || !isIndexableUri(uri)) {
      return
    }

    const uriKey = uri.toString()
    this.pendingDocumentUpdates.delete(uriKey)
    this.pendingUriUpdates.delete(uriKey)
    this.deleteIndexedDocument(uriKey)
    this.templateCache.invalidateDocument(uriKey)

    if (this.isLimited) {
      this.restart()
    }
  }

  private finishInitialScan(): void {
    if (!this.hasFinishedInitialScan) {
      this.hasFinishedInitialScan = true
      this.resolveReady()
    }
  }

  private async flushPendingUpdates(): Promise<void> {
    this.pendingUpdateTimer = undefined

    for (const document of this.pendingDocumentUpdates.values()) {
      this.indexTextDocument(document)
    }

    const uriUpdates = [...this.pendingUriUpdates.values()].map((uri) => this.indexUri(uri))

    this.pendingDocumentUpdates.clear()
    this.pendingUriUpdates.clear()
    await Promise.all(uriUpdates)
  }

  private getCustomPropertyAtPosition(document: vscode.TextDocument, position: vscode.Position) {
    const source = document.getText()
    const offset = document.offsetAt(position)

    if (isCssDocument(document)) {
      return isCssTextOffsetProtected(source, offset)
        ? undefined
        : findCssCustomPropertyAtOffset(source, offset)
    }

    if (!isHostDocument(document)) {
      return undefined
    }

    const context = this.getTemplateContext(document, offset)

    if (!context || context.kind !== 'static') {
      return undefined
    }

    const offsetInTemplate = offset - context.template.bodyStart

    if (isCssTextOffsetProtected(context.template.maskedBody, offsetInTemplate)) {
      return undefined
    }

    const token = findCssCustomPropertyAtOffset(context.template.maskedBody, offsetInTemplate)

    return token
      ? {
          ...token,
          end: context.template.bodyStart + token.end,
          start: context.template.bodyStart + token.start,
        }
      : undefined
  }

  private getCustomPropertyCompletions(
    document: vscode.TextDocument,
    offset: number,
    completionContext: { hasClosingParenthesis: boolean; prefix: string },
    token: vscode.CancellationToken,
  ): vscode.CompletionList | undefined {
    if (token.isCancellationRequested) {
      return undefined
    }

    const candidates = this.index
      .getCustomPropertyCandidates(document.uri.toString(), (fromUri, specifier) =>
        this.resolveCssImport(fromUri, specifier),
      )
      .filter((candidate) => candidate.definition.name.startsWith(completionContext.prefix))
    const range = new vscode.Range(
      document.positionAt(offset - completionContext.prefix.length),
      document.positionAt(offset),
    )

    return new vscode.CompletionList(
      candidates.map(({ definition, priority }, index) => {
        const item = new vscode.CompletionItem(
          `var(${definition.name})`,
          vscode.CompletionItemKind.Variable,
        )

        item.detail = `CSS custom property from ${definition.relativePath}`
        item.documentation = new vscode.MarkdownString(`Defined in \`${definition.relativePath}\`.`)
        item.filterText = definition.name
        item.insertText = `${definition.name}${completionContext.hasClosingParenthesis ? '' : ')'}`
        item.range = range
        item.sortText = `!yak-project-token-${priority}-${String(index).padStart(4, '0')}`
        return item
      }),
      true,
    )
  }

  private getMixinCompletions(
    document: vscode.TextDocument,
    completionContext: MixinCompletionContext,
    token: vscode.CancellationToken,
  ): vscode.CompletionList | undefined {
    if (token.isCancellationRequested) {
      return undefined
    }

    const mixins = this.index
      .getMixins(document.uri.toString())
      .filter((mixin) => mixin.name.startsWith(completionContext.prefix))

    return new vscode.CompletionList(
      mixins.map((mixin, index) =>
        this.toMixinCompletionItem(mixin, document, completionContext.range, index),
      ),
      false,
    )
  }

  private getMixinCompletionContext(
    document: vscode.TextDocument,
    offset: number,
    context: TemplateInterpolationContext,
  ): MixinCompletionContext | undefined {
    const expressionStart = context.template.bodyStart + context.interpolationStart + 2
    const expression = document.getText(
      new vscode.Range(document.positionAt(expressionStart), document.positionAt(offset)),
    )
    const match = /^\s*([_$a-zA-Z][_$a-zA-Z0-9]*)?$/.exec(expression)

    if (!match) {
      return undefined
    }

    const prefix = match[1] ?? ''

    return {
      prefix,
      range: new vscode.Range(
        document.positionAt(offset - prefix.length),
        document.positionAt(offset),
      ),
    }
  }

  private getTemplateContext(
    document: vscode.TextDocument,
    offset: number,
  ): TemplateContext | undefined {
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

    const template = templates
      .filter((candidate) => offset >= candidate.bodyStart && offset <= candidate.bodyEnd)
      .sort((left, right) => left.bodyEnd - left.bodyStart - (right.bodyEnd - right.bodyStart))[0]

    if (!template) {
      return undefined
    }

    const offsetInTemplate = offset - template.bodyStart
    const interpolation = template.interpolations.find((range) =>
      isOffsetInRange(offsetInTemplate, range),
    )

    return interpolation
      ? { interpolationStart: interpolation.start, kind: 'interpolation', template }
      : { kind: 'static', template }
  }

  private indexTextDocument(document: vscode.TextDocument): void {
    const uri = document.uri.toString()

    if (!isIndexableDocument(document)) {
      this.deleteIndexedDocument(uri)
      this.templateCache.invalidateDocument(uri)
      return
    }

    this.templateCache.invalidateDocument(uri)
    if (
      !this.indexDocument(
        toProjectIndexDocument(document),
        getTemplateLibraries(document.uri),
        getDocumentByteLength(document),
      )
    ) {
      this.showLimitedStatus()
    }
  }

  private deleteIndexedDocument(uri: string): void {
    const previousSize = this.indexedFileSizes.get(uri)

    if (previousSize !== undefined) {
      this.indexedFileSizes.delete(uri)
      this.indexedTotalBytes -= previousSize
    }

    this.index.deleteDocument(uri)
  }

  private indexDocument(
    document: ProjectIndexDocument,
    templateLibraries: readonly TemplateLibraryProfile[],
    byteLength: number,
  ): boolean {
    const previousSize = this.indexedFileSizes.get(document.uri)
    const indexedFileCount = this.indexedFileSizes.size + (previousSize === undefined ? 1 : 0)
    const indexedTotalBytes = this.indexedTotalBytes - (previousSize ?? 0) + byteLength

    if (
      byteLength > projectIndexMaxFileBytes ||
      indexedFileCount > projectIndexMaxFiles ||
      indexedTotalBytes > projectIndexMaxTotalBytes
    ) {
      this.deleteIndexedDocument(document.uri)
      this.markLimited(
        byteLength > projectIndexMaxFileBytes
          ? 'file-size'
          : indexedFileCount > projectIndexMaxFiles
            ? 'file-count'
            : 'total-size',
      )
      return false
    }

    this.index.updateDocument(document, templateLibraries)
    this.indexedFileSizes.set(document.uri, byteLength)
    this.indexedTotalBytes = indexedTotalBytes
    return true
  }

  private async indexUri(uri: vscode.Uri): Promise<void> {
    if (this.isDisposed || !this.isStarted || !isIndexableUri(uri)) {
      return
    }

    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    )

    if (openDocument) {
      this.indexTextDocument(openDocument)
      return
    }

    try {
      const stat = await vscode.workspace.fs.stat(uri)

      if (stat.size > projectIndexMaxFileBytes) {
        this.deleteIndexedDocument(uri.toString())
        this.markLimited('file-size')
        this.showLimitedStatus()
        return
      }

      const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))

      if (
        !this.indexDocument(
          toProjectIndexDocumentFromUri(uri, source),
          getTemplateLibraries(uri),
          stat.size,
        )
      ) {
        this.showLimitedStatus()
      }
    } catch {
      this.deleteIndexedDocument(uri.toString())
    }
  }

  private async indexWorkspace(token: vscode.CancellationToken, generation: number): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders

    if (!workspaceFolders || workspaceFolders.length === 0) {
      return
    }

    const uris = await vscode.workspace.findFiles(
      projectIndexFilePattern,
      projectIndexExcludePattern,
      projectIndexMaxFiles + 1,
      token,
    )

    if (!this.isCurrentScan(generation, token)) {
      return
    }

    if (uris.length > projectIndexMaxFiles) {
      this.markLimited('file-count')
    }

    for (const uri of uris.slice(0, projectIndexMaxFiles)) {
      if (!this.isCurrentScan(generation, token)) {
        return
      }

      try {
        const stat = await vscode.workspace.fs.stat(uri)

        if (stat.size > projectIndexMaxFileBytes) {
          this.markLimited('file-size')
          continue
        }

        const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))

        if (!this.isCurrentScan(generation, token)) {
          return
        }

        if (
          !this.indexDocument(
            toProjectIndexDocumentFromUri(uri, source),
            getTemplateLibraries(uri),
            stat.size,
          )
        ) {
          this.isLimited = true
          continue
        }
        const indexedFiles = this.indexedFileSizes.size

        if (indexedFiles % 50 === 0) {
          this.showIndexingStatus(indexedFiles, Math.min(uris.length, projectIndexMaxFiles))
        }
      } catch {
        this.deleteIndexedDocument(uri.toString())
      }
    }

    for (const document of vscode.workspace.textDocuments) {
      if (isIndexableDocument(document)) {
        this.indexTextDocument(document)
      }
    }
  }

  private isCurrentScan(generation: number, token: vscode.CancellationToken): boolean {
    return !this.isDisposed && !token.isCancellationRequested && generation === this.scanGeneration
  }

  private queueDocumentUpdate(document: vscode.TextDocument): void {
    if (!this.isStarted || !isIndexableDocument(document)) {
      return
    }

    this.pendingDocumentUpdates.set(document.uri.toString(), document)
    this.schedulePendingUpdates()
  }

  private queueUriUpdate(uri: vscode.Uri): void {
    if (!this.isStarted || !isIndexableUri(uri)) {
      return
    }

    this.pendingUriUpdates.set(uri.toString(), uri)
    this.schedulePendingUpdates()
  }

  private resolveCssImport(fromUri: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.')) {
      return undefined
    }

    const sourceUri = vscode.Uri.parse(fromUri)
    const relativeSpecifier = specifier.replace(/[?#].*$/, '')
    const path = posix.normalize(posix.join(posix.dirname(sourceUri.path), relativeSpecifier))

    return sourceUri.with({ path, query: '', fragment: '' }).toString()
  }

  private markLimited(reason: ProjectIndexLimitReason): void {
    this.isLimited = true
    this.limitReason ??= reason
  }

  private restart(): void {
    if (this.isDisposed || !this.isStarted) {
      return
    }

    this.scanCancellation?.cancel()
    this.scanCancellation?.dispose()
    this.scanCancellation = new vscode.CancellationTokenSource()
    this.indexedFileSizes.clear()
    this.indexedTotalBytes = 0
    this.index.clear()
    this.templateCache.clear()
    this.isLimited = false
    this.limitReason = undefined
    const generation = ++this.scanGeneration
    const token = this.scanCancellation.token

    this.showIndexingStatus(0)
    void this.indexWorkspace(token, generation).then(
      () => {
        if (!this.isCurrentScan(generation, token)) {
          return
        }

        if (this.isLimited) {
          this.showLimitedStatus()
        } else {
          this.statusBarItem.hide()
        }

        this.finishInitialScan()
      },
      () => {
        if (this.isCurrentScan(generation, token)) {
          this.showLimitedStatus('Yak: CSS index unavailable')
          this.finishInitialScan()
        }
      },
    )
  }

  private restoreClosedDocument(document: vscode.TextDocument): void {
    this.templateCache.invalidateDocument(document.uri.toString())

    if (document.uri.scheme === 'untitled') {
      this.deleteIndexedDocument(document.uri.toString())
      return
    }

    this.queueUriUpdate(document.uri)
  }

  private schedulePendingUpdates(): void {
    if (this.pendingUpdateTimer === undefined) {
      this.pendingUpdateTimer = setTimeout(() => {
        void this.flushPendingUpdates()
      }, projectIndexDocumentUpdateDelayMilliseconds)
    }
  }

  private async handleRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    if (!this.isStarted) {
      return
    }

    try {
      const stat = await vscode.workspace.fs.stat(newUri)

      if ((stat.type & vscode.FileType.Directory) !== 0) {
        this.restart()
        return
      }
    } catch {
      this.restart()
      return
    }

    this.deleteUri(oldUri)
    this.queueUriUpdate(newUri)
  }

  private showIndexingStatus(indexedFiles: number, totalFiles?: number): void {
    const progress = totalFiles === undefined ? '' : ` ${indexedFiles}/${totalFiles}`

    this.statusBarItem.text = `$(sync~spin) Yak: indexing CSS${progress}`
    this.statusBarItem.show()
  }

  private showLimitedStatus(text = getProjectIndexLimitMessage(this.limitReason)): void {
    this.statusBarItem.text = `$(warning) ${text}`
    this.statusBarItem.show()
  }

  private toMixinCompletionItem(
    mixin: IndexedCssMixin,
    document: vscode.TextDocument,
    range: vscode.Range,
    index: number,
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(mixin.name, vscode.CompletionItemKind.Value)

    item.detail =
      mixin.uri === document.uri.toString()
        ? 'Static CSS mixin in this file'
        : `Exported CSS mixin from ${mixin.relativePath}`
    item.documentation = new vscode.MarkdownString(
      mixin.uri === document.uri.toString()
        ? 'Static `css` mixin defined in this file.'
        : `Static ` + '`css` mixin exported from `' + `\`${mixin.relativePath}\`.`,
    )
    item.filterText = mixin.name
    item.insertText = mixin.name
    item.range = range
    item.sortText = `!yak-project-mixin-${mixin.uri === document.uri.toString() ? '0' : '1'}-${String(index).padStart(4, '0')}`

    if (
      mixin.uri !== document.uri.toString() &&
      !isNamedImportPresent(document.getText(), mixin.name)
    ) {
      const importSpecifier = getRelativeImportSpecifier(document.uri, vscode.Uri.parse(mixin.uri))

      if (importSpecifier) {
        item.additionalTextEdits = [
          vscode.TextEdit.insert(
            document.positionAt(getImportInsertionOffset(document.getText())),
            `import { ${mixin.name} } from '${importSpecifier}'\n`,
          ),
        ]
      }
    }

    return item
  }

  private async toLocations(
    entries: readonly IndexedCssCustomProperty[],
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[]> {
    const documents = new Map<string, vscode.TextDocument>()
    const locations: vscode.Location[] = []

    for (const entry of entries) {
      if (token.isCancellationRequested) {
        return []
      }

      let document = documents.get(entry.uri)

      if (!document) {
        try {
          document =
            vscode.workspace.textDocuments.find(
              (candidate) => candidate.uri.toString() === entry.uri,
            ) ?? (await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri)))
        } catch {
          this.deleteIndexedDocument(entry.uri)
          continue
        }
        documents.set(entry.uri, document)
      }

      locations.push(
        new vscode.Location(
          document.uri,
          new vscode.Range(document.positionAt(entry.start), document.positionAt(entry.end)),
        ),
      )
    }

    return locations
  }

  private async waitForInitialIndex(token: vscode.CancellationToken): Promise<boolean> {
    if (this.hasFinishedInitialScan) {
      return !token.isCancellationRequested
    }

    let cancellationSubscription: vscode.Disposable | undefined

    try {
      await Promise.race([
        this.whenReady,
        new Promise<void>((resolve) => {
          cancellationSubscription = token.onCancellationRequested(resolve)
        }),
      ])
    } finally {
      cancellationSubscription?.dispose()
    }

    return !token.isCancellationRequested
  }
}

function getProjectIndexLimitMessage(reason: ProjectIndexLimitReason | undefined): string {
  if (reason === 'file-size') {
    return `Yak: CSS index limited to ${projectIndexMaxFileBytes / 1024} KB per file`
  }

  if (reason === 'total-size') {
    return `Yak: CSS index limited to ${projectIndexMaxTotalBytes / (1024 * 1024)} MB total`
  }

  return `Yak: CSS index limited to ${projectIndexMaxFiles.toLocaleString()} files`
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]<>]/g, '\\$&')
}

function getCustomPropertyCompletionContext(source: string, offset: number) {
  const match = /(?:^|[\s:(,])var\s*\(\s*(--[-_a-zA-Z0-9]*)?$/i.exec(source.slice(0, offset))

  return match
    ? { hasClosingParenthesis: source[offset] === ')', prefix: match[1] ?? '' }
    : undefined
}

function getImportInsertionOffset(source: string): number {
  const imports = [...source.matchAll(/^import[^\n]*(?:\n|$)/gm)]
  const lastImport = imports.at(-1)

  return lastImport ? lastImport.index + lastImport[0].length : 0
}

function getLanguageId(uri: vscode.Uri): string {
  const path = uri.path.toLowerCase()

  if (path.endsWith('.css')) {
    return 'css'
  }
  if (path.endsWith('.tsx')) {
    return 'typescriptreact'
  }
  if (path.endsWith('.ts')) {
    return 'typescript'
  }
  if (path.endsWith('.jsx')) {
    return 'javascriptreact'
  }

  return 'javascript'
}

function getDocumentByteLength(document: vscode.TextDocument): number {
  return textEncoder.encode(document.getText()).byteLength
}

function getRelativeImportSpecifier(
  fromUri: vscode.Uri,
  targetUri: vscode.Uri,
): string | undefined {
  if (fromUri.scheme !== targetUri.scheme || fromUri.authority !== targetUri.authority) {
    return undefined
  }

  const targetPath = targetUri.path.replace(/\.(?:jsx?|tsx?)$/i, '')
  let relativePath = posix.relative(posix.dirname(fromUri.path), targetPath)

  if (!relativePath || relativePath.startsWith('../') || relativePath.startsWith('./')) {
    return relativePath || './'
  }

  return `./${relativePath}`
}

function getTemplateLibraries(uri: vscode.Uri) {
  const ids = vscode.workspace
    .getConfiguration('yak', uri)
    .get<readonly string[]>('templateLibraries', templateLibraryIds)

  return getTemplateLibraryProfiles(ids)
}

function isCssDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'css' || document.uri.path.toLowerCase().endsWith('.css')
}

function isHostDocument(document: vscode.TextDocument): boolean {
  return hostLanguageIds.has(document.languageId)
}

function isIndexableDocument(document: vscode.TextDocument): boolean {
  return isCssDocument(document) || isHostDocument(document)
}

function isIndexableUri(uri: vscode.Uri): boolean {
  const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')
  return isProjectIndexablePath(relativePath) && !excludedProjectPathExpression.test(relativePath)
}

function isNamedImportPresent(source: string, name: string): boolean {
  const escapedName = name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  return new RegExp(`\\bimport\\s*{[^}]*\\b${escapedName}\\b[^}]*}`, 's').test(source)
}

function toProjectIndexDocument(document: vscode.TextDocument): ProjectIndexDocument {
  return {
    fileName: document.fileName,
    languageId: document.languageId,
    relativePath: vscode.workspace.asRelativePath(document.uri, false),
    source: document.getText(),
    uri: document.uri.toString(),
  }
}

function toProjectIndexDocumentFromUri(uri: vscode.Uri, source: string): ProjectIndexDocument {
  return {
    fileName: uri.fsPath || uri.path,
    languageId: getLanguageId(uri),
    relativePath: vscode.workspace.asRelativePath(uri, false),
    source,
    uri: uri.toString(),
  }
}
