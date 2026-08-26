import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface PackageManifest {
  version: string
}

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url))
const packageManifest = JSON.parse(
  await readFile(join(workspaceRoot, 'package.json'), 'utf8'),
) as PackageManifest
const outputDirectory = join(workspaceRoot, 'build')
const outputPath = join('build', `vscode-yak-${packageManifest.version}.vsix`)
const yarnExecutable = process.platform === 'win32' ? 'yarn.cmd' : 'yarn'

await mkdir(outputDirectory, { recursive: true })

const packageProcess = spawn(
  yarnExecutable,
  ['vsce', 'package', '--no-yarn', '--no-dependencies', '--out', outputPath],
  {
    cwd: workspaceRoot,
    stdio: 'inherit',
  },
)
const exitCode = await new Promise<number | null>((resolve, reject) => {
  packageProcess.once('error', reject)
  packageProcess.once('close', resolve)
})

if (exitCode !== 0) {
  throw new Error(`VSIX packaging failed with exit code ${exitCode ?? 'unknown'}.`)
}
