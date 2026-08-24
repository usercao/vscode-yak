import { defineConfig } from 'tsdown'

export default defineConfig({
  deps: {
    neverBundle: ['vscode'],
  },
  entry: ['src/extension.ts'],
  format: 'cjs',
  outDir: 'dist',
  platform: 'node',
})
