import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { runTests } from '@vscode/test-electron'

const extensionDevelopmentPath = resolve(import.meta.dirname, '..')
const bundledMacOsExecutable = '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH
  ?? (process.platform === 'darwin' && existsSync(bundledMacOsExecutable) ? bundledMacOsExecutable : undefined)

const options = {
  extensionDevelopmentPath,
  extensionTestsPath: join(extensionDevelopmentPath, 'test', 'integration', 'extensionHost.cjs'),
  launchArgs: [
    join(extensionDevelopmentPath, 'test-workspace'),
    '--disable-extensions',
  ],
  version: '1.134.0',
}

if (vscodeExecutablePath) {
  options.vscodeExecutablePath = vscodeExecutablePath
}

try {
  await runTests(options)
} catch (error) {
  console.error(error)
  process.exitCode = 1
}