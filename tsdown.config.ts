import { fileURLToPath } from 'node:url'

import { defineConfig } from 'tsdown'

const cssLanguageServiceEsmEntry = fileURLToPath(
  new URL(
    './node_modules/vscode-css-languageservice/lib/esm/cssLanguageService.js',
    import.meta.url,
  ),
)
const textDocumentEsmEntry = fileURLToPath(
  new URL('./node_modules/vscode-languageserver-textdocument/lib/esm/main.js', import.meta.url),
)

export default defineConfig({
  alias: {
    'vscode-css-languageservice': cssLanguageServiceEsmEntry,
    'vscode-languageserver-textdocument': textDocumentEsmEntry,
  },
  deps: {
    alwaysBundle: [
      'color-name',
      'typescript',
      'vscode-css-languageservice',
      'vscode-languageserver-textdocument',
    ],
    neverBundle: ['vscode'],
    onlyBundle: [
      '@vscode/l10n',
      'color-name',
      'typescript',
      'vscode-css-languageservice',
      'vscode-languageserver-textdocument',
      'vscode-languageserver-types',
      'vscode-uri',
    ],
  },
  entry: ['src/activation.ts', 'src/extension.ts', 'src/folding.ts'],
  format: 'esm',
  outDir: 'dist',
  platform: 'node',
  shims: true,
  target: 'node24',
})
