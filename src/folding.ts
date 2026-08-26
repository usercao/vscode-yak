import * as vscode from 'vscode'

import { getCssFoldingRanges } from './foldingRanges'
import { TemplateCache, type TemplateDocument } from './template'
import { getTemplateLibraryProfiles, type TemplateLibraryProfile } from './templateLibraries'

export class CssFoldingProvider implements vscode.FoldingRangeProvider {
  constructor(private readonly templateCache = new TemplateCache()) {}

  provideFoldingRanges(
    document: vscode.TextDocument,
    _context: vscode.FoldingContext,
    token: vscode.CancellationToken,
  ): vscode.FoldingRange[] | undefined {
    if (token.isCancellationRequested) {
      return undefined
    }

    const source = document.getText()
    const templates = this.templateCache.findTemplates(
      toTemplateDocument(document, source),
      getTemplateLibraries(document.uri),
    )
    const ranges: vscode.FoldingRange[] = []

    for (const template of templates) {
      if (token.isCancellationRequested) {
        return undefined
      }

      ranges.push(
        ...getCssFoldingRanges(source, template).map(
          (range) => new vscode.FoldingRange(range.start, range.end),
        ),
      )
    }

    return ranges
  }
}

function getTemplateLibraries(uri: vscode.Uri): readonly TemplateLibraryProfile[] {
  const enabledProfileIds = vscode.workspace
    .getConfiguration('yak', uri)
    .get<readonly string[]>('templateLibraries')

  return getTemplateLibraryProfiles(enabledProfileIds)
}

function toTemplateDocument(document: vscode.TextDocument, source: string): TemplateDocument {
  return {
    fileName: document.fileName,
    languageId: document.languageId,
    source,
    uri: document.uri.toString(),
    version: document.version,
  }
}
