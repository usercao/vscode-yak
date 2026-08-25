import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma'
import { INITIAL, Registry } from 'vscode-textmate'

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))
const vscodeExtensionsRoot = findVscodeExtensionsRoot()

let onigurumaReady: Promise<void> | undefined

function findVscodeExtensionsRoot() {
  const executablePath = process.env.VSCODE_EXECUTABLE_PATH
  const executableCandidates = executablePath ? [
    join(dirname(executablePath), '..', 'Resources', 'app', 'extensions'),
    join(dirname(executablePath), 'resources', 'app', 'extensions'),
  ] : []
  const platformCandidates = process.platform === 'darwin'
    ? ['/Applications/Visual Studio Code.app/Contents/Resources/app/extensions']
    : process.platform === 'win32'
      ? [
          join(process.env.ProgramFiles ?? '', 'Microsoft VS Code', 'resources', 'app', 'extensions'),
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'resources', 'app', 'extensions'),
        ]
      : [
          '/usr/share/code/resources/app/extensions',
          '/usr/share/code-insiders/resources/app/extensions',
        ]
  const extensionsRoot = [...executableCandidates, ...platformCandidates].find(existsSync)

  if (!extensionsRoot) {
    throw new Error('Unable to find the VS Code extensions directory. Set VSCODE_EXECUTABLE_PATH to the VS Code executable.')
  }

  return extensionsRoot
}

async function loadGrammar(scopeName: string) {
  if (!onigurumaReady) {
    onigurumaReady = readFile(join(process.cwd(), 'node_modules/vscode-oniguruma/release/onig.wasm'))
      .then((wasm) => loadWASM(wasm.buffer))
  }

  await onigurumaReady

  const grammarPaths: Record<string, string> = {
    'next-yak.injection': join(workspaceRoot, 'syntaxes/next-yak.injection.json'),
    'next-yak-js.injection': join(workspaceRoot, 'syntaxes/next-yak-js.injection.json'),
    'source.css': join(vscodeExtensionsRoot, 'css/syntaxes/css.tmLanguage.json'),
    'source.js': join(vscodeExtensionsRoot, 'javascript/syntaxes/JavaScript.tmLanguage.json'),
    'source.js.jsx': join(vscodeExtensionsRoot, 'javascript/syntaxes/JavaScriptReact.tmLanguage.json'),
    'source.ts': join(vscodeExtensionsRoot, 'typescript-basics/syntaxes/TypeScript.tmLanguage.json'),
    'source.tsx': join(vscodeExtensionsRoot, 'typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json'),
  }
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new OnigScanner(sources),
      createOnigString: (text) => new OnigString(text),
    }),
    loadGrammar: async (requestedScopeName) => {
      const grammarPath = grammarPaths[requestedScopeName]
      return grammarPath ? JSON.parse(await readFile(grammarPath, 'utf8')) : null
    },
    getInjections: (requestedScopeName) => {
      return requestedScopeName === 'source.ts' || requestedScopeName === 'source.tsx'
        ? ['next-yak.injection']
        : requestedScopeName === 'source.js' || requestedScopeName === 'source.js.jsx'
          ? ['next-yak-js.injection']
          : []
    },
  })

  return registry.loadGrammarWithConfiguration(scopeName, 1, {
    embeddedLanguages: { 'source.css': 1 },
  })
}

function scopesAtOffset(line: string, tokens: readonly { endIndex: number; scopes: readonly string[] }[], offset: number) {
  const token = tokens.find((candidate) => offset < candidate.endIndex)

  if (!token) {
    throw new Error(`No token found at offset ${offset} in ${line}`)
  }

  return token.scopes
}

describe('next-yak TextMate grammar', () => {
  it.each([
    ['TypeScript', 'source.ts'],
    ['TypeScript React', 'source.tsx'],
    ['JavaScript', 'source.js'],
    ['JavaScript React', 'source.js.jsx'],
  ])('highlights static attrs, namespace, and keyframes forms in %s', async (_, scopeName) => {
    const grammar = await loadGrammar(scopeName)

    if (!grammar) {
      throw new Error(`Unable to load ${scopeName} grammar`)
    }

    let ruleStack = INITIAL
    const lines = [
      "import { globalStyle, keyframes, styled } from 'next-yak'",
      "import * as yak from 'next-yak'",
      'const Attrs = styled.div.attrs({ role: createRole("region") })`',
      '  color: red;',
      '`',
      'const Namespaced = yak.styled.a`',
      '  background: blue;',
      '`',
      'const Global = yak.globalStyle`',
      '  border-color: black;',
      '`',
      'const Animation = yak.keyframes`',
      '  from { opacity: 0; }',
      '`',
      'const after = true',
    ]
    const tokenizedLines = lines.map((line) => {
      const result = grammar.tokenizeLine(line, ruleStack)
      ruleStack = result.ruleStack
      return result.tokens
    })

    for (const [lineIndex, property] of [
      [3, 'color'],
      [6, 'background'],
      [9, 'border-color'],
      [12, 'opacity'],
    ] as const) {
      const scopes = scopesAtOffset(lines[lineIndex], tokenizedLines[lineIndex], lines[lineIndex].indexOf(property))

      expect(scopes).toContain('support.type.property-name.css')
      expect(scopes).toContain('source.css')
      expect(scopes).not.toContain('source.css.scss')
      expect(scopes).not.toContain('source.css.less')
    }
    expect(scopesAtOffset(lines[14], tokenizedLines[14], lines[14].indexOf('const'))).not.toContain('source.css')
  })

  it.each([
    ['TypeScript', 'source.ts'],
    ['TypeScript React', 'source.tsx'],
  ])('highlights generic styled and static element-access templates in %s', async (_, scopeName) => {
    const grammar = await loadGrammar(scopeName)

    if (!grammar) {
      throw new Error(`Unable to load ${scopeName} grammar`)
    }

    let ruleStack = INITIAL
    const lines = [
      "import { styled } from 'next-yak'",
      'type Props = { tone: string }',
      'const Generic = styled.div<Props>`',
      '  color: red;',
      '`',
      "const Element = styled['section']`",
      '  background: blue;',
      '`',
      'const Callable = styled(Component).attrs<Props>({ role: "presentation" })`',
      '  outline-color: black;',
      '`',
      'const after = true',
    ]
    const tokenizedLines = lines.map((line) => {
      const result = grammar.tokenizeLine(line, ruleStack)
      ruleStack = result.ruleStack
      return result.tokens
    })

    for (const [lineIndex, property] of [
      [3, 'color'],
      [6, 'background'],
      [9, 'outline-color'],
    ] as const) {
      expect(scopesAtOffset(lines[lineIndex], tokenizedLines[lineIndex], lines[lineIndex].indexOf(property))).toContain(
        'support.type.property-name.css',
      )
    }
    expect(scopesAtOffset(lines[11], tokenizedLines[11], lines[11].indexOf('const'))).not.toContain('source.css')
  })

  it.each([
    ['TypeScript React', 'source.tsx'],
    ['JavaScript React', 'source.js.jsx'],
  ])('highlights direct and namespace css prop templates in %s', async (_, scopeName) => {
    const grammar = await loadGrammar(scopeName)

    if (!grammar) {
      throw new Error(`Unable to load ${scopeName} grammar`)
    }

    let ruleStack = INITIAL
    const lines = [
      "import { css } from 'next-yak'",
      "import * as yak from 'next-yak'",
      'const Direct = <section css={css`',
      '  color: red;',
      '`} />',
      'const Namespaced = <section css={yak.css`',
      '  background: blue;',
      '`} />',
      'const after = true',
    ]
    const tokenizedLines = lines.map((line) => {
      const result = grammar.tokenizeLine(line, ruleStack)
      ruleStack = result.ruleStack
      return result.tokens
    })

    expect(scopesAtOffset(lines[3], tokenizedLines[3], lines[3].indexOf('color'))).toContain(
      'support.type.property-name.css',
    )
    expect(scopesAtOffset(lines[6], tokenizedLines[6], lines[6].indexOf('background'))).toContain(
      'support.type.property-name.css',
    )
    expect(scopesAtOffset(lines[8], tokenizedLines[8], lines[8].indexOf('const'))).not.toContain('source.css')
  })

  it.each([
    ['TypeScript', 'source.ts'],
    ['TypeScript React', 'source.tsx'],
    ['JavaScript', 'source.js'],
    ['JavaScript React', 'source.js.jsx'],
  ])('does not guess alias tags as CSS templates in %s', async (_, scopeName) => {
    const grammar = await loadGrammar(scopeName)

    if (!grammar) {
      throw new Error(`Unable to load ${scopeName} grammar`)
    }

    let ruleStack = INITIAL
    const lines = [
      'const Panel = s.div`',
      '  color: red;',
      '`',
      'const after = true',
    ]
    const tokenizedLines = lines.map((line) => {
      const result = grammar.tokenizeLine(line, ruleStack)
      ruleStack = result.ruleStack
      return result.tokens
    })

    expect(scopesAtOffset(lines[1], tokenizedLines[1], lines[1].indexOf('color'))).not.toContain(
      'support.type.property-name.css',
    )
    expect(scopesAtOffset(lines[3], tokenizedLines[3], lines[3].indexOf('const'))).not.toContain('source.css')
  })

  it.each([
    ['TypeScript React', 'source.tsx'],
    ['JavaScript React', 'source.js.jsx'],
  ])('highlights pseudo-classes and pseudo-elements inside %s styled templates', async (_, scopeName) => {
    const grammar = await loadGrammar(scopeName)

    if (!grammar) {
      throw new Error(`Unable to load ${scopeName} grammar`)
    }

    let ruleStack = INITIAL
    const lines = [
      "import { styled } from 'next-yak'",
      'const Link = styled.a`',
      '  a:hover',
      '  a::before',
      '  a:hover {}',
      '  a::before {}',
      '  cursor:default',
      '  color:red',
      '`',
    ]
    const tokenizedLines = lines.map((line) => {
      const result = grammar.tokenizeLine(line, ruleStack)
      ruleStack = result.ruleStack
      return result.tokens
    })

    expect(scopesAtOffset(lines[2], tokenizedLines[2], lines[2].indexOf(':hover'))).toContain(
      'entity.other.attribute-name.pseudo-class.css',
    )
    expect(scopesAtOffset(lines[3], tokenizedLines[3], lines[3].indexOf('::before'))).toContain(
      'entity.other.attribute-name.pseudo-element.css',
    )
    expect(scopesAtOffset(lines[4], tokenizedLines[4], lines[4].indexOf(':hover'))).toContain(
      'entity.other.attribute-name.pseudo-class.css',
    )
    expect(scopesAtOffset(lines[5], tokenizedLines[5], lines[5].indexOf('::before'))).toContain(
      'entity.other.attribute-name.pseudo-element.css',
    )
    expect(scopesAtOffset(lines[6], tokenizedLines[6], lines[6].indexOf('cursor'))).toContain(
      'support.type.property-name.css',
    )
    expect(scopesAtOffset(lines[7], tokenizedLines[7], lines[7].indexOf('color'))).toContain(
      'support.type.property-name.css',
    )
    expect(scopesAtOffset(lines[4], tokenizedLines[4], lines[4].indexOf('{'))).toContain(
      'punctuation.section.property-list.begin.bracket.curly.css',
    )
  })

  it.each([
    ['TypeScript', 'source.ts'],
    ['TypeScript React', 'source.tsx'],
    ['JavaScript', 'source.js'],
    ['JavaScript React', 'source.js.jsx'],
  ])('highlights keyframe steps and preserves host syntax in %s', async (_, scopeName) => {
    const grammar = await loadGrammar(scopeName)

    if (!grammar) {
      throw new Error(`Unable to load ${scopeName} grammar`)
    }

    const tokenize = (lines: readonly string[]) => {
      let ruleStack = INITIAL

      return lines.map((line) => {
        const result = grammar.tokenizeLine(line, ruleStack)
        ruleStack = result.ruleStack
        return result.tokens
      })
    }
    const lines = [
      "import { keyframes } from 'next-yak'",
      'const spin = keyframes`',
      '  from { transform: rotate(0deg); }',
      '  0%, 50%, 72%, 100% { opacity: 0.5; }',
      '  to { transform: rotate(1turn); }',
      '`',
      'const after = true',
    ]
    const tokenizedLines = tokenize(lines)

    for (const [lineIndex, text] of [
      [2, 'from'],
      [4, 'to'],
    ] as const) {
      expect(scopesAtOffset(lines[lineIndex], tokenizedLines[lineIndex], lines[lineIndex].indexOf(text))).toContain(
        'entity.other.keyframe-offset.css',
      )
    }
    for (const text of ['0%', '50%', '72%', '100%']) {
      expect(scopesAtOffset(lines[3], tokenizedLines[3], lines[3].indexOf(text))).toContain(
        'entity.other.keyframe-offset.percentage.css',
      )
    }
    expect(scopesAtOffset(lines[2], tokenizedLines[2], lines[2].indexOf('transform'))).toContain(
      'support.type.property-name.css',
    )
    expect(scopesAtOffset(lines[2], tokenizedLines[2], lines[2].indexOf('rotate'))).toContain(
      'support.function.transform.css',
    )
    expect(scopesAtOffset(lines[3], tokenizedLines[3], lines[3].indexOf('opacity'))).toContain(
      'support.type.property-name.css',
    )
    expect(scopesAtOffset(lines[6], tokenizedLines[6], lines[6].indexOf('const'))).not.toContain('source.css')

    const incompleteLines = [
      "import { keyframes } from 'next-yak'",
      'const spin = keyframes`',
      '  50',
      '`',
      'const after = true',
    ]
    const incompleteTokens = tokenize(incompleteLines)

    expect(scopesAtOffset(incompleteLines[4], incompleteTokens[4], incompleteLines[4].indexOf('const'))).not.toContain(
      'source.css',
    )

    const openStepLines = [
      "import { keyframes } from 'next-yak'",
      'const spin = keyframes`',
      '  from {',
      '`',
      'const after = true',
    ]
    const openStepTokens = tokenize(openStepLines)

    expect(scopesAtOffset(openStepLines[4], openStepTokens[4], openStepLines[4].indexOf('const'))).not.toContain(
      'source.css',
    )
  })

  it.each([
    ['TypeScript React', 'source.tsx'],
    ['JavaScript React', 'source.js.jsx'],
  ])('documents that %s highlighting can statically misidentify unrelated styled templates', async (_, scopeName) => {
    const grammar = await loadGrammar(scopeName)

    if (!grammar) {
      throw new Error(`Unable to load ${scopeName} grammar`)
    }

    let ruleStack = INITIAL
    const lines = [
      "import { styled } from 'another-library'",
      'const Link = styled.a`',
      '  color: red;',
      '`',
    ]
    const tokenizedLines = lines.map((line) => {
      const result = grammar.tokenizeLine(line, ruleStack)
      ruleStack = result.ruleStack
      return result.tokens
    })

    expect(scopesAtOffset(lines[2], tokenizedLines[2], lines[2].indexOf('color'))).toContain(
      'support.type.property-name.css',
    )
  })
})
