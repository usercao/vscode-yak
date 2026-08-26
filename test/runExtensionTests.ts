import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { runTests } from '@vscode/test-electron'

const extensionDevelopmentPath = resolve(process.cwd())
const bundledMacOsExecutable = '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
const vscodeExecutablePath =
  process.env.VSCODE_EXECUTABLE_PATH ??
  (process.platform === 'darwin' && existsSync(bundledMacOsExecutable)
    ? bundledMacOsExecutable
    : undefined)

async function main(): Promise<void> {
  try {
    const workspacePath = join(
      extensionDevelopmentPath,
      '.vscode-test',
      'vscode-yak-test.code-workspace',
    )

    await mkdir(join(extensionDevelopmentPath, '.vscode-test'), { recursive: true })
    await writeFile(
      workspacePath,
      `${JSON.stringify(
        {
          folders: [
            { path: join(extensionDevelopmentPath, 'test-workspace') },
            {
              name: 'test-workspace-extra',
              path: join(extensionDevelopmentPath, 'test-workspace-extra'),
            },
          ],
        },
        undefined,
        2,
      )}\n`,
    )

    const options = {
      extensionDevelopmentPath,
      extensionTestsPath: join(
        extensionDevelopmentPath,
        '.vscode-test',
        'compiled',
        'integration',
        'extensionHost.mjs',
      ),
      launchArgs: [workspacePath, '--disable-extensions'],
      version: '1.134.0',
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    }

    await runTests(options)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

void main()
