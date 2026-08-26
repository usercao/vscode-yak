import { describe, expect, it } from 'vitest'

import {
  findCssCustomPropertyAtOffset,
  isCssTextOffsetProtected,
  ProjectCssIndex,
} from '../src/projectIndex'

const workspaceUri = 'file:///workspace'

function uri(path: string): string {
  return `${workspaceUri}/${path}`
}

function resolveCssImport(fromUri: string, specifier: string): string | undefined {
  const paths = new Map([
    [
      uri('app.tsx'),
      new Map([['./components/Button.module.css', uri('components/Button.module.css')]]),
    ],
  ])

  return paths.get(fromUri)?.get(specifier)
}

describe('ProjectCssIndex', () => {
  it('indexes CSS custom properties with explicit local, module, token, and global priority', () => {
    const index = new ProjectCssIndex()
    const consumerUri = uri('app.tsx')

    index.updateDocument({
      fileName: '/workspace/tokens/colors.css',
      languageId: 'css',
      relativePath: 'tokens/colors.css',
      source: ':root { --brand: #176b5b; /* --comment: red; */ content: "--literal: blue"; }',
      uri: uri('tokens/colors.css'),
    })
    index.updateDocument({
      fileName: '/workspace/components/Button.module.css',
      languageId: 'css',
      relativePath: 'components/Button.module.css',
      source: ':root { --button-accent: #123456; }',
      uri: uri('components/Button.module.css'),
    })
    index.updateDocument({
      fileName: '/workspace/components/Card.module.css',
      languageId: 'css',
      relativePath: 'components/Card.module.css',
      source: ':root { --card-accent: #654321; }',
      uri: uri('components/Card.module.css'),
    })
    index.updateDocument({
      fileName: '/workspace/styles/global.css',
      languageId: 'css',
      relativePath: 'styles/global.css',
      source: '@import "../tokens/colors.css"; :root { --global-accent: black; }',
      uri: uri('styles/global.css'),
    })
    index.updateDocument({
      fileName: '/workspace/app.tsx',
      languageId: 'typescriptreact',
      relativePath: 'app.tsx',
      source: [
        "import { css } from 'next-yak'",
        "import styles from './components/Button.module.css'",
        'const local = css`',
        '  --local-accent: var(--brand);',
        '`',
      ].join('\n'),
      uri: consumerUri,
    })

    expect(index.getCustomPropertyCandidates(consumerUri, resolveCssImport)).toEqual([
      expect.objectContaining({
        definition: expect.objectContaining({ name: '--local-accent' }),
        priority: 0,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ name: '--button-accent' }),
        priority: 1,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ name: '--brand' }),
        priority: 2,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ name: '--global-accent' }),
        priority: 4,
      }),
    ])
    expect(
      index
        .getCustomPropertyCandidates(consumerUri, resolveCssImport)
        .map((candidate) => candidate.definition.name),
    ).not.toContain('--card-accent')

    expect(index.getDefinitions('--brand', consumerUri, resolveCssImport)).toHaveLength(1)
    expect(index.getDefinitions('--card-accent', consumerUri, resolveCssImport)).toEqual([])
    expect(index.getReferences('--brand', true)).toHaveLength(2)
  })

  it('resolves transitive CSS imports while avoiding import cycles', () => {
    const index = new ProjectCssIndex()
    const consumerUri = uri('app.tsx')
    const importMap = new Map([
      [consumerUri, new Map([['./styles/global.css', uri('styles/global.css')]])],
      [uri('styles/global.css'), new Map([['../tokens/colors.css', uri('tokens/colors.css')]])],
      [uri('tokens/colors.css'), new Map([['../styles/global.css', uri('styles/global.css')]])],
    ])

    index.updateDocument({
      fileName: '/workspace/styles/global.css',
      languageId: 'css',
      relativePath: 'styles/global.css',
      source: '@import "../tokens/colors.css"; :root { --global: black; }',
      uri: uri('styles/global.css'),
    })
    index.updateDocument({
      fileName: '/workspace/tokens/colors.css',
      languageId: 'css',
      relativePath: 'tokens/colors.css',
      source: '@import "../styles/global.css"; :root { --linked-token: white; }',
      uri: uri('tokens/colors.css'),
    })
    index.updateDocument({
      fileName: '/workspace/app.tsx',
      languageId: 'typescriptreact',
      relativePath: 'app.tsx',
      source: "import './styles/global.css'",
      uri: consumerUri,
    })

    const resolver = (fromUri: string, specifier: string) => importMap.get(fromUri)?.get(specifier)

    expect(index.getCustomPropertyCandidates(consumerUri, resolver)).toEqual([
      expect.objectContaining({
        definition: expect.objectContaining({ name: '--linked-token' }),
        priority: 2,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ name: '--global' }),
        priority: 3,
      }),
    ])
  })

  it('indexes only static local and exported CSS mixins', () => {
    const index = new ProjectCssIndex()
    const consumerUri = uri('consumer.tsx')

    index.updateDocument({
      fileName: '/workspace/mixins.ts',
      languageId: 'typescript',
      relativePath: 'mixins.ts',
      source: [
        "import { css } from 'next-yak'",
        'export const compact = css`display: grid;`',
        'const dynamic = css`color: ${tone};`',
      ].join('\n'),
      uri: uri('mixins.ts'),
    })
    index.updateDocument({
      fileName: '/workspace/consumer.tsx',
      languageId: 'typescriptreact',
      relativePath: 'consumer.tsx',
      source: ["import { css } from 'next-yak'", 'const local = css`color: red;`'].join('\n'),
      uri: consumerUri,
    })

    expect(index.getMixins(consumerUri)).toMatchObject([
      { exported: false, name: 'local', uri: consumerUri },
      { exported: true, name: 'compact', uri: uri('mixins.ts') },
    ])
  })

  it('locates custom property tokens and rejects protected CSS text', () => {
    const source = 'color: var(--brand); /* --comment */ content: "--literal";'
    const tokenOffset = source.indexOf('--brand') + 4

    expect(findCssCustomPropertyAtOffset(source, tokenOffset)).toEqual({
      end: source.indexOf('--brand') + '--brand'.length,
      name: '--brand',
      start: source.indexOf('--brand'),
    })
    expect(isCssTextOffsetProtected(source, source.indexOf('--comment'))).toBe(true)
    expect(isCssTextOffsetProtected(source, source.indexOf('--literal'))).toBe(true)
  })
})
