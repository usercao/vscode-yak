import { defineConfig } from 'tsdown'

export default defineConfig({
  deps: {
    neverBundle: ['@vscode/test-electron', 'vscode'],
  },
  entry: {
    runExtensionTests: 'test/runExtensionTests.ts',
    'integration/extensionHost': 'test/integration/extensionHost.ts',
  },
  format: 'cjs',
  outDir: '.vscode-test/compiled',
  platform: 'node',
  target: 'node24',
})
