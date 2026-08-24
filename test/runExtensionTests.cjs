const fs = require('node:fs')
const path = require('node:path')
const { runTests } = require('@vscode/test-electron')

const extensionDevelopmentPath = path.resolve(__dirname, '..')
const bundledMacOsExecutable = '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH
  ?? (process.platform === 'darwin' && fs.existsSync(bundledMacOsExecutable) ? bundledMacOsExecutable : undefined)

const options = {
  extensionDevelopmentPath,
  extensionTestsPath: path.join(extensionDevelopmentPath, 'test', 'integration', 'extensionHost.cjs'),
  launchArgs: [
    path.join(extensionDevelopmentPath, 'test-workspace'),
    '--disable-extensions',
  ],
  version: '1.134.0',
}

if (vscodeExecutablePath) {
  options.vscodeExecutablePath = vscodeExecutablePath
}

runTests(options).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
