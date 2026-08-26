import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInjectionGrammar } from '../src/grammarDefinition.ts'

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url))
const checkOnly = process.argv.includes('--check')
const outputDefinitions = [
  {
    fileName: 'typescript.injection.json',
    grammar: createInjectionGrammar({
      scopeName: 'yak.injection',
      injectionSelector: 'L:source.ts, L:source.tsx',
      language: 'typescript',
    }),
  },
  {
    fileName: 'javascript.injection.json',
    grammar: createInjectionGrammar({
      scopeName: 'yak-js.injection',
      injectionSelector: 'L:source.js, L:source.js.jsx',
      language: 'javascript',
    }),
  },
] as const
const outdatedFiles: string[] = []

for (const { fileName, grammar } of outputDefinitions) {
  const outputPath = join(workspaceRoot, 'syntaxes', fileName)
  const content = `${JSON.stringify(grammar, null, 2)}\n`

  if (checkOnly) {
    let existingContent: string | undefined

    try {
      existingContent = await readFile(outputPath, 'utf8')
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
    }

    if (existingContent !== content) {
      outdatedFiles.push(join('syntaxes', fileName))
    }

    continue
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, content)
}

if (outdatedFiles.length > 0) {
  throw new Error(`Generated TextMate grammars are out of date: ${outdatedFiles.join(', ')}`)
}
