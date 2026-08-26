import * as vscode from 'vscode'

import type { CssLanguageRuntime } from './extension'
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
  let runtime: CssLanguageRuntime | undefined
  let runtimePromise: Promise<CssLanguageRuntime> | undefined
  let runtimeStartTimer: ReturnType<typeof setTimeout> | undefined
  let isDisposed = false
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

  const refreshDiagnostics = (loadedRuntime: CssLanguageRuntime) => {
    for (const document of vscode.workspace.textDocuments) {
      loadedRuntime.updateDiagnostics(document)
    }
  }

  const updateDiagnostics = (document: vscode.TextDocument) => {
    if (!runtime && !mightContainEnabledTemplateLibraryImport(document)) {
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

      return useRuntime(
        (loadedRuntime) =>
          token.isCancellationRequested
            ? undefined
            : loadedRuntime.foldingProvider.provideFoldingRanges(document, foldingContext, token),
        undefined,
      )
    },
  }

  runtimeStartTimer = setTimeout(() => {
    runtimeStartTimer = undefined

    if (!vscode.workspace.textDocuments.some(mightContainEnabledTemplateLibraryImport)) {
      resolveWhenReady()
      return
    }

    void loadRuntime().then(
      (loadedRuntime) => {
        if (isDisposed) {
          return
        }

        refreshDiagnostics(loadedRuntime)
        resolveWhenReady()
      },
      (error: unknown) => {
        reportRuntimeError(error)
        rejectWhenReady(error)
      },
    )
  }, 0)

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      updateDiagnostics(event.document)
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      runtime?.invalidateDocument(document.uri.toString())
      runtime?.deleteDiagnostics(document.uri)
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      updateDiagnostics(document)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const templateLibrariesChanged = event.affectsConfiguration(templateLibrariesConfiguration)

      if (!templateLibrariesChanged && !event.affectsConfiguration(cssValidateConfiguration)) {
        return
      }

      if (
        !runtime &&
        !vscode.workspace.textDocuments.some(mightContainEnabledTemplateLibraryImport)
      ) {
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

      if (runtimeStartTimer !== undefined) {
        clearTimeout(runtimeStartTimer)
      }

      rejectWhenReady(new Error('The yak CSS language runtime was disposed before initialization.'))
      runtime?.dispose()
    }),
  )

  return { whenReady }
}

function mightContainEnabledTemplateLibraryImport(document: vscode.TextDocument) {
  if (!supportedLanguageIds.has(document.languageId)) {
    return false
  }

  const enabledProfileIds = vscode.workspace
    .getConfiguration('yak', document.uri)
    .get<readonly string[]>('templateLibraries', templateLibraryIds)
  const source = document.getText()

  return getTemplateLibraryProfiles(enabledProfileIds).some((profile) =>
    profile.moduleSpecifiers.some((specifier) => source.includes(specifier)),
  )
}
