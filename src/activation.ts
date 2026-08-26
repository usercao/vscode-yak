import * as vscode from 'vscode'

import type { CssLanguageRuntime } from './extension'
import type { CssFoldingProvider } from './folding'
import { getTemplateLibraryProfiles, templateLibraryIds } from './templateLibraries'

const supportedDocumentSelector: vscode.DocumentSelector = [
  { language: 'javascript' },
  { language: 'javascriptreact' },
  { language: 'typescript' },
  { language: 'typescriptreact' },
]
const cssCompletionTriggerCharacters =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:-@'.split('')
const cssValidateConfiguration = 'yak.css.validate'
const templateLibrariesConfiguration = 'yak.templateLibraries'
const supportedLanguageIds = new Set([
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
])

export interface ActivationApi {
  readonly whenReady: Promise<void>
}

export function activate(context: vscode.ExtensionContext): ActivationApi {
  const templateImportCandidates = new Map<
    string,
    { matches: boolean; profileKey: string; version: number }
  >()
  let runtime: CssLanguageRuntime | undefined
  let runtimePromise: Promise<CssLanguageRuntime> | undefined
  let runtimePreloadTimer: ReturnType<typeof setTimeout> | undefined
  let isDisposed = false
  let foldingProviderPromise: Promise<CssFoldingProvider> | undefined
  let hasReportedFoldingProviderError = false
  let hasReportedRuntimeError = false
  let hasSettledReady = false
  let rejectReady!: (reason?: unknown) => void
  let resolveReady!: () => void
  const whenReady = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  void whenReady.catch(() => {})

  const reportRuntimeError = (error: unknown) => {
    if (!hasReportedRuntimeError) {
      hasReportedRuntimeError = true
      console.error('Unable to load the yak CSS language runtime.', error)
    }
  }

  const reportFoldingProviderError = (error: unknown) => {
    if (!hasReportedFoldingProviderError) {
      hasReportedFoldingProviderError = true
      console.error('Unable to load the yak CSS folding provider.', error)
    }
  }

  const resolveWhenReady = () => {
    if (!hasSettledReady) {
      hasSettledReady = true
      resolveReady()
    }
  }

  const rejectWhenReady = (error: unknown) => {
    if (!hasSettledReady) {
      hasSettledReady = true
      rejectReady(error)
    }
  }

  const loadRuntime = () => {
    runtimePromise ??= import('./extension').then(({ createCssLanguageRuntime }) => {
      const loadedRuntime = createCssLanguageRuntime()
      runtime = loadedRuntime

      if (isDisposed) {
        loadedRuntime.dispose()
      }

      return loadedRuntime
    })

    return runtimePromise
  }

  const loadFoldingProvider = () => {
    foldingProviderPromise ??= import('./folding').then(
      ({ CssFoldingProvider }) => new CssFoldingProvider(),
    )

    return foldingProviderPromise
  }

  const mightContainEnabledTemplateLibraryImport = (document: vscode.TextDocument) => {
    if (!supportedLanguageIds.has(document.languageId)) {
      return false
    }

    const enabledProfileIds = vscode.workspace
      .getConfiguration('yak', document.uri)
      .get<readonly string[]>('templateLibraries', templateLibraryIds)
    const profiles = getTemplateLibraryProfiles(enabledProfileIds)
    const profileKey = profiles.map((profile) => profile.id).join(',')
    const uri = document.uri.toString()
    const cachedCandidate = templateImportCandidates.get(uri)

    if (
      cachedCandidate &&
      cachedCandidate.version === document.version &&
      cachedCandidate.profileKey === profileKey
    ) {
      return cachedCandidate.matches
    }

    const matches = profiles.some((profile) =>
      profile.moduleSpecifiers.some((specifier) => document.getText().includes(specifier)),
    )

    templateImportCandidates.set(uri, { matches, profileKey, version: document.version })
    return matches
  }

  const useRuntime = async <Result>(
    callback: (loadedRuntime: CssLanguageRuntime) => Result | PromiseLike<Result>,
    fallback: Result,
  ): Promise<Result> => {
    if (isDisposed) {
      return fallback
    }

    try {
      const loadedRuntime = await loadRuntime()

      return isDisposed ? fallback : await callback(loadedRuntime)
    } catch (error) {
      reportRuntimeError(error)
      return fallback
    }
  }

  const useFoldingProvider = async <Result>(
    callback: (loadedFoldingProvider: CssFoldingProvider) => Result | PromiseLike<Result>,
    fallback: Result,
  ): Promise<Result> => {
    if (isDisposed) {
      return fallback
    }

    try {
      const loadedFoldingProvider = await loadFoldingProvider()

      return isDisposed ? fallback : await callback(loadedFoldingProvider)
    } catch (error) {
      reportFoldingProviderError(error)
      return fallback
    }
  }

  const refreshDiagnostics = (loadedRuntime: CssLanguageRuntime) => {
    for (const document of vscode.workspace.textDocuments) {
      if (mightContainEnabledTemplateLibraryImport(document)) {
        loadedRuntime.updateDiagnostics(document)
      } else {
        loadedRuntime.invalidateDocument(document.uri.toString())
        loadedRuntime.deleteDiagnostics(document.uri)
      }
    }
  }

  const preloadRuntime = (document: vscode.TextDocument | undefined, settleReady = false) => {
    if (!document || !mightContainEnabledTemplateLibraryImport(document)) {
      if (settleReady) {
        resolveWhenReady()
      }
      return
    }

    void loadRuntime().then(
      (loadedRuntime) => {
        if (isDisposed) {
          return
        }

        refreshDiagnostics(loadedRuntime)

        if (settleReady) {
          resolveWhenReady()
        }
      },
      (error: unknown) => {
        reportRuntimeError(error)

        if (settleReady) {
          rejectWhenReady(error)
        }
      },
    )
  }

  const updateDiagnostics = (document: vscode.TextDocument) => {
    if (!mightContainEnabledTemplateLibraryImport(document)) {
      runtime?.invalidateDocument(document.uri.toString())
      runtime?.deleteDiagnostics(document.uri)
      return
    }

    if (!runtime) {
      if (vscode.window.activeTextEditor?.document === document) {
        preloadRuntime(document)
      }
      return
    }

    void useRuntime((loadedRuntime) => {
      loadedRuntime.invalidateDocument(document.uri.toString())
      loadedRuntime.updateDiagnostics(document)
    }, undefined)
  }

  const completionProvider: vscode.CompletionItemProvider = {
    async provideCompletionItems(document, position, token) {
      if (token.isCancellationRequested) {
        return undefined
      }

      if (!mightContainEnabledTemplateLibraryImport(document)) {
        return undefined
      }

      return useRuntime(
        (loadedRuntime) =>
          token.isCancellationRequested
            ? undefined
            : loadedRuntime.completionProvider.provideCompletionItems(document, position, token),
        undefined,
      )
    },
  }
  const hoverProvider: vscode.HoverProvider = {
    async provideHover(document, position, token) {
      if (token.isCancellationRequested) {
        return undefined
      }

      if (!mightContainEnabledTemplateLibraryImport(document)) {
        return undefined
      }

      return useRuntime(
        (loadedRuntime) =>
          token.isCancellationRequested
            ? undefined
            : loadedRuntime.hoverProvider.provideHover(document, position, token),
        undefined,
      )
    },
  }
  const codeActionProvider: vscode.CodeActionProvider = {
    async provideCodeActions(document, range, actionContext, token) {
      if (token.isCancellationRequested) {
        return undefined
      }

      if (!mightContainEnabledTemplateLibraryImport(document)) {
        return undefined
      }

      return useRuntime(
        (loadedRuntime) =>
          token.isCancellationRequested
            ? undefined
            : loadedRuntime.codeActionProvider.provideCodeActions(
                document,
                range,
                actionContext,
                token,
              ),
        undefined,
      )
    },
  }
  const colorProvider: vscode.DocumentColorProvider = {
    async provideDocumentColors(document, token) {
      if (token.isCancellationRequested) {
        return undefined
      }

      if (!mightContainEnabledTemplateLibraryImport(document)) {
        return undefined
      }

      return useRuntime(
        (loadedRuntime) =>
          token.isCancellationRequested
            ? undefined
            : loadedRuntime.colorProvider.provideDocumentColors(document, token),
        undefined,
      )
    },
    async provideColorPresentations(color, colorContext, token) {
      if (token.isCancellationRequested) {
        return []
      }

      if (!mightContainEnabledTemplateLibraryImport(colorContext.document)) {
        return []
      }

      return useRuntime(
        (loadedRuntime) =>
          token.isCancellationRequested
            ? []
            : loadedRuntime.colorProvider.provideColorPresentations(color, colorContext, token),
        [],
      )
    },
  }
  const foldingProvider: vscode.FoldingRangeProvider = {
    async provideFoldingRanges(document, foldingContext, token) {
      if (token.isCancellationRequested) {
        return undefined
      }

      if (!mightContainEnabledTemplateLibraryImport(document)) {
        return undefined
      }

      return useFoldingProvider(
        (loadedFoldingProvider) =>
          token.isCancellationRequested
            ? undefined
            : loadedFoldingProvider.provideFoldingRanges(document, foldingContext, token),
        undefined,
      )
    },
  }

  runtimePreloadTimer = setTimeout(() => {
    runtimePreloadTimer = undefined
    preloadRuntime(vscode.window.activeTextEditor?.document, true)
  }, 0)

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      updateDiagnostics(event.document)
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      templateImportCandidates.delete(document.uri.toString())
      runtime?.invalidateDocument(document.uri.toString())
      runtime?.deleteDiagnostics(document.uri)
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      updateDiagnostics(document)
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        updateDiagnostics(editor.document)
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const templateLibrariesChanged = event.affectsConfiguration(templateLibrariesConfiguration)

      if (!templateLibrariesChanged && !event.affectsConfiguration(cssValidateConfiguration)) {
        return
      }

      if (templateLibrariesChanged) {
        templateImportCandidates.clear()
      }

      if (!runtime) {
        preloadRuntime(vscode.window.activeTextEditor?.document)
        return
      }

      void useRuntime((loadedRuntime) => {
        if (templateLibrariesChanged) {
          loadedRuntime.clearTemplateCache()
        }

        refreshDiagnostics(loadedRuntime)
      }, undefined)
    }),
    vscode.languages.registerCompletionItemProvider(
      supportedDocumentSelector,
      completionProvider,
      ...cssCompletionTriggerCharacters,
    ),
    vscode.languages.registerHoverProvider(supportedDocumentSelector, hoverProvider),
    vscode.languages.registerCodeActionsProvider(supportedDocumentSelector, codeActionProvider, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.languages.registerColorProvider(supportedDocumentSelector, colorProvider),
    vscode.languages.registerFoldingRangeProvider(supportedDocumentSelector, foldingProvider),
    new vscode.Disposable(() => {
      isDisposed = true

      if (runtimePreloadTimer !== undefined) {
        clearTimeout(runtimePreloadTimer)
      }

      rejectWhenReady(new Error('The yak CSS language runtime was disposed before initialization.'))
      runtime?.dispose()
    }),
  )

  return { whenReady }
}
