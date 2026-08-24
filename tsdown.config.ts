import { defineConfig } from 'tsdown'

export default defineConfig({
  deps: {
    alwaysBundle: ['vscode-css-languageservice', 'vscode-languageserver-textdocument'],
    neverBundle: ['vscode'],
  },
  entry: ['src/extension.ts'],
  format: 'cjs',
  outDir: 'dist',
  platform: 'node',
  target: 'node18',
})
