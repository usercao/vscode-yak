import { describe, expect, it, vi } from 'vitest'

const { createProgramSpy, createSourceFileSpy } = vi.hoisted(() => ({
  createProgramSpy: vi.fn(),
  createSourceFileSpy: vi.fn(),
}))

vi.mock('typescript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('typescript')>()

  createProgramSpy.mockImplementation(actual.createProgram)
  createSourceFileSpy.mockImplementation(actual.createSourceFile)

  return {
    ...actual,
    createProgram: createProgramSpy,
    createSourceFile: createSourceFileSpy,
  }
})

import {
  createVirtualCssText,
  findTemplate,
  getAtRuleCompletionContext,
  getSelectorCompletionContext,
  mapVirtualRangeToSourceOffsets,
  TemplateCache,
} from '../src/template'
import { getTemplateLibraryProfiles } from '../src/templateLibraries'

const cursorMarker = '/*cursor*/'

function findTemplateAtCursor(source: string, languageId = 'typescriptreact') {
  const cursorOffset = source.indexOf(cursorMarker)

  if (cursorOffset === -1) {
    throw new Error(`Missing ${cursorMarker} marker`)
  }

  const sourceWithoutCursor = source.replace(cursorMarker, '')

  return {
    cursorOffset,
    source: sourceWithoutCursor,
    template: findTemplate(sourceWithoutCursor, cursorOffset, languageId, '/fixture.tsx'),
  }
}

function styledSource(tagExpression: string, importStatement = "import { styled } from 'yak'") {
  return [
    importStatement,
    `const Value = ${tagExpression}\``,
    `  color: red;${cursorMarker}`,
    '`',
  ].join('\n')
}

function sourceWithCursor(lines: readonly string[]) {
  return findTemplateAtCursor(lines.join('\n'))
}

function templateCacheRequest(
  sourceWithCursor: string,
  version: number,
  uri = 'file:///fixture.tsx',
) {
  const cursorOffset = sourceWithCursor.indexOf(cursorMarker)

  if (cursorOffset === -1) {
    throw new Error(`Missing ${cursorMarker} marker`)
  }

  return {
    cursorOffset,
    document: {
      fileName: '/fixture.tsx',
      languageId: 'typescriptreact',
      source: sourceWithCursor.replace(cursorMarker, ''),
      uri,
      version,
    },
  }
}

function expectTemplateTag(
  source: string,
  expectedTag: 'styled' | 'css' | 'globalStyle' | 'keyframes',
  languageId = 'typescriptreact',
) {
  expect(findTemplateAtCursor(source, languageId).template?.tag).toBe(expectedTag)
}

describe('findTemplate', () => {
  it.each(['next-yak', '@yak/react', 'yak'])(
    'recognizes %s as a yak migration module',
    (moduleSpecifier) => {
      const { template } = findTemplateAtCursor(
        styledSource('styled.div', `import { styled } from '${moduleSpecifier}'`),
      )

      expect(template).toMatchObject({ library: 'yak', tag: 'styled' })
    },
  )

  it.each(['next-yak', '@yak/react', 'yak'])(
    'recognizes aliases and namespace imports from %s',
    (moduleSpecifier) => {
      expect(
        findTemplateAtCursor(
          styledSource('s.div', `import { styled as s } from '${moduleSpecifier}'`),
        ).template,
      ).toMatchObject({ library: 'yak', tag: 'styled' })
      expect(
        findTemplateAtCursor(
          styledSource('library.css', `import * as library from '${moduleSpecifier}'`),
        ).template,
      ).toMatchObject({ library: 'yak', tag: 'css' })
    },
  )

  it.each([
    ['styled', 'styled.div'],
    ['css', 'css'],
    ['globalStyle', 'globalStyle'],
    ['keyframes', 'keyframes'],
  ])('recognizes direct yak %s imports', (expectedTag, tagExpression) => {
    const { template } = findTemplateAtCursor(
      styledSource(tagExpression, "import { css, globalStyle, keyframes, styled } from 'yak'"),
    )

    expect(template?.tag).toBe(expectedTag)
  })

  it('recognizes aliases and namespace imports', () => {
    expect(
      findTemplateAtCursor(styledSource('s.div', "import { styled as s } from 'yak'")).template
        ?.tag,
    ).toBe('styled')
    expect(
      findTemplateAtCursor(styledSource('rules', "import { css as rules } from 'yak'")).template
        ?.tag,
    ).toBe('css')
    expect(
      findTemplateAtCursor(styledSource('yak.styled.a', "import * as yak from 'yak'")).template
        ?.tag,
    ).toBe('styled')
    expect(
      findTemplateAtCursor(styledSource('yak.css', "import * as yak from 'yak'")).template?.tag,
    ).toBe('css')
  })

  it('recognizes styled-components default, named, and namespace imports', () => {
    expect(
      findTemplateAtCursor(styledSource('styled.button', "import styled from 'styled-components'"))
        .template,
    ).toMatchObject({ library: 'styled-components', tag: 'styled' })
    expect(
      findTemplateAtCursor(
        styledSource(
          'GlobalStyle',
          "import { createGlobalStyle as GlobalStyle } from 'styled-components'",
        ),
      ).template,
    ).toMatchObject({ library: 'styled-components', tag: 'globalStyle' })
    expect(
      findTemplateAtCursor(styledSource('sc.css', "import * as sc from 'styled-components'"))
        .template,
    ).toMatchObject({ library: 'styled-components', tag: 'css' })
    expect(
      findTemplateAtCursor(styledSource('sc.styled.a', "import * as sc from 'styled-components'"))
        .template,
    ).toMatchObject({ library: 'styled-components', tag: 'styled' })
  })

  it('does not recognize disabled template library profiles', () => {
    const sourceWithCursor = styledSource('styled.div', "import styled from 'styled-components'")
    const cursorOffset = sourceWithCursor.indexOf(cursorMarker)
    const source = sourceWithCursor.replace(cursorMarker, '')

    expect(
      findTemplate(
        source,
        cursorOffset,
        'typescriptreact',
        '/fixture.tsx',
        getTemplateLibraryProfiles(['yak']),
      ),
    ).toBeUndefined()
  })

  it('rejects type-only, shadowed, and unrelated styled-components bindings', () => {
    expect(
      findTemplateAtCursor(
        styledSource('styled.div', "import type styled from 'styled-components'"),
      ).template,
    ).toBeUndefined()
    expect(
      findTemplateAtCursor(styledSource('styled.div', "import styled from '@emotion/styled'"))
        .template,
    ).toBeUndefined()

    const source = [
      "import styled from 'styled-components'",
      'function render(styled: { div: unknown }) {',
      '  return styled.div`',
      `    color: red;${cursorMarker}`,
      '  `',
      '}',
    ].join('\n')

    expect(findTemplateAtCursor(source).template).toBeUndefined()
  })

  it('recognizes styled calls, type arguments, and attrs chains', () => {
    for (const tagExpression of [
      'styled(Component)',
      'styled.div<Props>',
      'styled.div.attrs({})',
      'styled(Component).attrs<Props>({})',
    ]) {
      expect(findTemplateAtCursor(styledSource(tagExpression)).template?.tag).toBe('styled')
    }
  })

  it.each([
    ['javascript', 'javascript'],
    ['JavaScript React', 'javascriptreact'],
    ['TypeScript', 'typescript'],
    ['TypeScript React', 'typescriptreact'],
  ])('recognizes static templates in %s documents', (_, languageId) => {
    expectTemplateTag(styledSource('styled.div'), 'styled', languageId)
  })

  it('recognizes css prop templates and selects the innermost matching template', () => {
    const source = [
      "import { css, styled } from 'yak'",
      'const Outer = styled.div`',
      '  color: red;',
      '  ${({ active }) => active && css`',
      `    background: blue;${cursorMarker}`,
      '  `}',
      '`',
      'const view = <section css={css`',
      '  display: grid;',
      '`} />',
    ].join('\n')

    const found = findTemplateAtCursor(source)

    expect(found.template?.tag).toBe('css')
    expect(found.template?.maskedBody).toContain('background: blue;')

    expectTemplateTag(
      [
        "import { css } from 'yak'",
        'const view = <section css={css`',
        `  display: grid;${cursorMarker}`,
        '`} />',
      ].join('\n'),
      'css',
    )
  })

  it('locates the correct template among adjacent and separate templates', () => {
    const source = [
      "import { css, styled } from 'yak'",
      'const First = styled.div`color: red;`',
      'const Second = styled.span`',
      `  background: blue;${cursorMarker}`,
      '`',
      'const third = css`border: 1px solid;`',
    ].join('\n')
    const found = findTemplateAtCursor(source)

    expect(found.template?.tag).toBe('styled')
    expect(found.template?.maskedBody).toContain('background: blue;')
    expect(found.template?.maskedBody).not.toContain('color: red;')
    expect(found.template?.maskedBody).not.toContain('border: 1px solid;')
  })

  it('supports static string element access and rejects dynamic tag paths', () => {
    expectTemplateTag(styledSource("styled['div']"), 'styled')
    expectTemplateTag(styledSource("yak.styled['section']", "import * as yak from 'yak'"), 'styled')

    for (const tagExpression of [
      'styled[tagName]',
      'yak.styled[tagName]',
      'styled[createTag()]',
      'wrap(styled.div)',
      'getStyled().div',
    ]) {
      expect(findTemplateAtCursor(styledSource(tagExpression)).template).toBeUndefined()
    }
  })

  it('defines import type, duplicate, conflict, and invalid import behavior', () => {
    expect(
      findTemplateAtCursor(styledSource('styled.div', "import type { styled } from 'yak'"))
        .template,
    ).toBeUndefined()
    expect(
      findTemplateAtCursor(styledSource('styled.div', "import { type styled } from 'yak'"))
        .template,
    ).toBeUndefined()
    expect(
      findTemplateAtCursor(styledSource('yak.styled.div', "import type * as yak from 'yak'"))
        .template,
    ).toBeUndefined()

    expect(
      findTemplateAtCursor(
        styledSource(
          'styled.div',
          ["import type { styled } from 'yak'", "import { styled } from 'yak'"].join('\n'),
        ),
      ).template,
    ).toBeUndefined()

    expectTemplateTag(
      styledSource(
        's.div',
        [
          "import type { styled as StyledType } from 'yak'",
          "import { styled as s } from 'yak'",
        ].join('\n'),
      ),
      'styled',
    )

    expectTemplateTag(
      styledSource(
        's.div',
        ["import { styled } from 'yak'", "import { styled as s } from 'yak'"].join('\n'),
      ),
      'styled',
    )

    expect(
      findTemplateAtCursor(styledSource('styled.div', "import { styled as } from 'yak'")).template,
    ).toBeUndefined()
  })

  it('does not handle similarly named tags from another module or local bindings', () => {
    expect(
      findTemplateAtCursor(styledSource('styled.div', "import { styled } from 'another-library'"))
        .template,
    ).toBeUndefined()

    const source = [
      "import { styled } from 'yak'",
      'function render(styled: { div: unknown }) {',
      '  return styled.div`',
      `    color: red;${cursorMarker}`,
      '  `',
      '}',
    ].join('\n')

    expect(findTemplateAtCursor(source).template).toBeUndefined()
  })

  it('skips interpolations while preserving the static CSS mapping', () => {
    const source = [
      "import { styled } from 'yak'",
      'const accent = "rebeccapurple"',
      'const Panel = styled.div`',
      '  color: ${accent};',
      `  background: red;${cursorMarker}`,
      '`',
    ].join('\n')
    const { template } = findTemplateAtCursor(source)

    expect(template?.maskedBody).not.toContain('${accent}')
    expect(template?.maskedBody).toMatch(/color:\s+;/)
    expect(template?.maskedBody).toContain('background: red;')
    expect(template?.maskedBody.length).toBe((template?.bodyEnd ?? 0) - (template?.bodyStart ?? 0))

    const interpolationSource = source.replace(
      'background: red;/*cursor*/',
      'background: ${/*cursor*/accent};',
    )
    expect(findTemplateAtCursor(interpolationSource).template).toBeUndefined()
  })

  it('preserves multiline nested interpolations while locating later static CSS', () => {
    const source = [
      "import { css, styled } from 'yak'",
      'const Panel = styled.div`',
      '  ${({ active }) => active && css`',
      '    color: red;',
      '    ${() => ({ nested: true }) && css`background: blue;`}',
      '  `}',
      `  border-color: black;${cursorMarker}`,
      '`',
    ].join('\n')
    const { template } = findTemplateAtCursor(source)

    expect(template?.interpolations).toHaveLength(1)
    expect(template?.maskedBody).toContain('border-color: black;')
    expect(template?.maskedBody).not.toContain('background: blue;')
    expect(template?.maskedBody.length).toBe((template?.bodyEnd ?? 0) - (template?.bodyStart ?? 0))
  })

  it('does not terminate interpolations on braces in strings, comments, or nested templates', () => {
    const source = [
      "import { styled } from 'yak'",
      'const Panel = styled.div`',
      '  color: ${({ tone }) => {',
      '    const closingBrace = "}";',
      '    const closingBracePattern = /}/;',
      '    /* } */',
      '    // }',
      '    return `tone-${tone}`;',
      '  }};',
      `  background: blue;${cursorMarker}`,
      '`',
    ].join('\n')
    const { template } = findTemplateAtCursor(source)

    expect(template?.interpolations).toHaveLength(1)
    expect(template?.maskedBody).toContain('background: blue;')
    expect(template?.maskedBody).not.toContain('closingBrace')
    expect(template?.maskedBody).not.toContain('closingBracePattern')
    expect(template?.maskedBody).not.toContain('tone-${tone}')
  })

  it('does not terminate interpolations on braces inside regular expression literals', () => {
    const source = [
      "import { styled } from 'yak'",
      'const Panel = styled.div`',
      `  color: \${/[}]/.test(tone) ? 'red' : 'blue'};`,
      `  background: blue;${cursorMarker}`,
      '`',
    ].join('\n')
    const { template } = findTemplateAtCursor(source)

    expect(template?.interpolations).toHaveLength(1)
    expect(template?.maskedBody).not.toContain('.test(tone)')
    expect(template?.maskedBody).not.toContain("'red'")
    expect(template?.maskedBody).toContain('background: blue;')
  })

  it('does not mistake division expressions for regular expression literals', () => {
    const source = [
      "import { styled } from 'yak'",
      'const Panel = styled.div`',
      `  width: \${size / 2};`,
      `  background: blue;${cursorMarker}`,
      '`',
    ].join('\n')
    const { template } = findTemplateAtCursor(source)

    expect(template?.interpolations).toHaveLength(1)
    expect(template?.maskedBody).not.toContain('size / 2')
    expect(template?.maskedBody).toContain('background: blue;')
  })

  it('preserves CRLF line endings while masking interpolations', () => {
    const source = [
      "import { styled } from 'yak'",
      'const Panel = styled.div`',
      '  color: ${accent};',
      `  background: blue;${cursorMarker}`,
      '`',
    ].join('\r\n')
    const found = findTemplateAtCursor(source)
    const { template } = found
    const body = found.source.slice(
      template?.bodyStart,
      (template?.bodyStart ?? 0) + (template?.maskedBody.length ?? 0),
    )

    expect(template?.maskedBody).toContain('\r\n')
    expect(template?.maskedBody.match(/\r\n/g)?.length).toBe(body.match(/\r\n/g)?.length)
    expect(template?.maskedBody.length).toBe(body.length)
  })

  it('does not throw for incomplete templates, interpolations, or malformed TSX', () => {
    const cases = [
      ["import { styled } from 'yak'", 'const Panel = styled.div`', `  color: re${cursorMarker}`],
      [
        "import { styled } from 'yak'",
        'const Panel = styled.div`',
        `  color: \${({ theme }) => theme.${cursorMarker}`,
      ],
      [
        "import { styled } from 'yak'",
        'const Panel = <div>',
        '  {styled.div`',
        `    color: red;${cursorMarker}`,
        '  `}',
      ],
    ]

    for (const lines of cases) {
      expect(() => sourceWithCursor(lines)).not.toThrow()
    }
  })

  it('rejects cursors in unfinished interpolations while retaining static incomplete templates', () => {
    const unfinishedInterpolation = sourceWithCursor([
      "import { styled } from 'yak'",
      'const Panel = styled.div`',
      `  color: \${({ theme }) => theme.${cursorMarker}`,
    ])
    const unfinishedTemplate = sourceWithCursor([
      "import { styled } from 'yak'",
      'const Panel = styled.div`',
      `  col${cursorMarker}`,
    ])

    expect(unfinishedInterpolation.template).toBeUndefined()
    expect(unfinishedTemplate.template?.tag).toBe('styled')
  })
})

describe('TemplateCache', () => {
  it('lists all recognized templates from one cached semantic analysis', () => {
    const cache = new TemplateCache()
    const source = [
      "import { css, styled } from 'yak'",
      'const First = styled.div`color: red;`',
      'const Second = css`background: blue;`',
    ].join('\n')
    const document = {
      fileName: '/fixture.tsx',
      languageId: 'typescriptreact',
      source,
      uri: 'file:///fixture.tsx',
      version: 1,
    }

    createProgramSpy.mockClear()
    expect(cache.findTemplates(document).map((template) => template.tag)).toEqual(['styled', 'css'])
    expect(cache.findTemplates(document)).toHaveLength(2)
    expect(createProgramSpy).toHaveBeenCalledTimes(1)
  })

  it('skips a template with an unfinished interpolation while retaining other templates', () => {
    const cache = new TemplateCache()
    const source = [
      "import { css, styled } from 'yak'",
      'const First = styled.div`color: ${theme.',
      'const Second = css`background: blue;`',
    ].join('\n')

    const templates = cache.findTemplates({
      fileName: '/fixture.tsx',
      languageId: 'typescriptreact',
      source,
      uri: 'file:///fixture.tsx',
      version: 1,
    })

    expect(templates.map((template) => template.tag)).toEqual(['css'])
    expect(templates[0].maskedBody).toContain('background: blue;')
  })

  it('reuses the semantic analysis for repeated completion requests at the same URI and version', () => {
    const cache = new TemplateCache()
    const request = templateCacheRequest(styledSource('styled.div'), 1)

    createProgramSpy.mockClear()
    expect(cache.findTemplate(request.document, request.cursorOffset)?.tag).toBe('styled')
    expect(cache.findTemplate(request.document, request.cursorOffset)?.tag).toBe('styled')
    expect(createProgramSpy).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(1)
  })

  it('rebuilds bindings when a document version changes so removed imports cannot remain active', () => {
    const cache = new TemplateCache()
    const initial = templateCacheRequest(styledSource('styled.div'), 1)
    const modified = templateCacheRequest(
      ["import { css } from 'yak'", 'const Value = styled.div`', `  col${cursorMarker}`, '`'].join(
        '\n',
      ),
      2,
      initial.document.uri,
    )

    expect(cache.findTemplate(initial.document, initial.cursorOffset)?.tag).toBe('styled')
    expect(cache.findTemplate(modified.document, modified.cursorOffset)).toBeUndefined()
    expect(cache.size).toBe(1)
  })

  it('invalidates a closed document before its URI is reopened', () => {
    const cache = new TemplateCache()
    const initial = templateCacheRequest(styledSource('styled.div'), 1)
    const reopened = templateCacheRequest(
      ["import { css } from 'yak'", 'const Value = styled.div`', `  col${cursorMarker}`, '`'].join(
        '\n',
      ),
      1,
      initial.document.uri,
    )

    expect(cache.findTemplate(initial.document, initial.cursorOffset)?.tag).toBe('styled')
    cache.invalidateDocument(initial.document.uri)
    expect(cache.size).toBe(0)
    expect(cache.findTemplate(reopened.document, reopened.cursorOffset)).toBeUndefined()
  })

  it('rebuilds the parsed AST when a document language changes', () => {
    const cache = new TemplateCache()
    const tsx = templateCacheRequest(styledSource('styled.div'), 1)
    const javascript = {
      ...tsx.document,
      languageId: 'javascript',
    }

    createProgramSpy.mockClear()
    expect(cache.findTemplate(tsx.document, tsx.cursorOffset)?.tag).toBe('styled')
    expect(cache.findTemplate(javascript, tsx.cursorOffset)?.tag).toBe('styled')
    expect(createProgramSpy).toHaveBeenCalledTimes(2)
  })

  it('rebuilds the semantic analysis when enabled profiles change', () => {
    const cache = new TemplateCache()
    const request = templateCacheRequest(
      styledSource('styled.div', "import styled from 'styled-components'"),
      1,
    )

    createProgramSpy.mockClear()
    expect(cache.findTemplate(request.document, request.cursorOffset)?.library).toBe(
      'styled-components',
    )
    expect(
      cache.findTemplate(
        request.document,
        request.cursorOffset,
        getTemplateLibraryProfiles(['yak']),
      ),
    ).toBeUndefined()
    expect(createProgramSpy).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed TypeScript parse and recovers on the next request', () => {
    const cache = new TemplateCache()
    const request = templateCacheRequest(styledSource('styled.div'), 1)

    createSourceFileSpy.mockClear()
    createSourceFileSpy.mockImplementationOnce(() => {
      throw new Error('TypeScript parser unavailable')
    })

    expect(cache.findTemplate(request.document, request.cursorOffset)).toBeUndefined()
    expect(cache.size).toBe(0)
    expect(cache.findTemplate(request.document, request.cursorOffset)?.tag).toBe('styled')
    expect(cache.size).toBe(1)
    expect(createSourceFileSpy).toHaveBeenCalledTimes(2)
  })
})

describe('virtual CSS mapping', () => {
  it('wraps component CSS and maps ranges back to source offsets', () => {
    const { template } = findTemplateAtCursor(styledSource('styled.div'))

    expect(template).toBeDefined()

    const virtualCss = createVirtualCssText(template!)
    expect(virtualCss.text).toMatch(/^:root \{\n/)
    expect(
      mapVirtualRangeToSourceOffsets(
        virtualCss.prefixLength,
        virtualCss.prefixLength + 5,
        virtualCss.prefixLength,
        template!.bodyStart,
        template!.maskedBody.length,
      ),
    ).toEqual({ start: template!.bodyStart, end: template!.bodyStart + 5 })
  })

  it('maps multiline virtual ranges and rejects wrapper or out-of-bounds edits', () => {
    const prefixLength = 12
    const sourceStart = 40
    const sourceText = 'first line\nsecond line\nthird line'
    const secondLineStart = sourceText.indexOf('second')
    const thirdLineStart = sourceText.indexOf('third')

    expect(
      mapVirtualRangeToSourceOffsets(
        prefixLength + secondLineStart,
        prefixLength + thirdLineStart,
        prefixLength,
        sourceStart,
        sourceText.length,
      ),
    ).toEqual({
      start: sourceStart + secondLineStart,
      end: sourceStart + thirdLineStart,
    })

    for (const [virtualStart, virtualEnd] of [
      [prefixLength - 1, prefixLength],
      [prefixLength + 5, prefixLength + 4],
      [prefixLength, prefixLength + sourceText.length + 1],
    ]) {
      expect(
        mapVirtualRangeToSourceOffsets(
          virtualStart,
          virtualEnd,
          prefixLength,
          sourceStart,
          sourceText.length,
        ),
      ).toBeUndefined()
    }
  })

  it('extracts an incomplete selector line for pseudo completion', () => {
    const source = [
      "import { styled } from 'yak'",
      'const Link = styled.a`',
      `  a:${cursorMarker}`,
      '`',
    ].join('\n')
    const found = findTemplateAtCursor(source)

    expect(found.template).toBeDefined()
    expect(getSelectorCompletionContext(found.source, found.cursorOffset, found.template!)).toEqual(
      {
        sourceStart: found.source.indexOf('a:'),
        text: 'a:',
      },
    )
  })

  it('does not extract selectors from at-rules, interpolations, or completed rules', () => {
    const cases = ['@media', 'a:hover {', '${value}']

    for (const line of cases) {
      const found = sourceWithCursor([
        "import { styled } from 'yak'",
        'const Value = styled.div`',
        `  ${line}${cursorMarker}`,
        '`',
      ])

      expect(found.template).toBeDefined()
      expect(
        getSelectorCompletionContext(found.source, found.cursorOffset, found.template!),
      ).toBeUndefined()
    }
  })

  it('classifies at-rule names, preludes, grouped rules, and descriptors', () => {
    const name = sourceWithCursor([
      "import { styled } from 'yak'",
      'const Value = styled.div`',
      `  @med${cursorMarker}`,
      '`',
    ])
    expect(getAtRuleCompletionContext(name.source, name.cursorOffset, name.template!)).toEqual({
      allowsTopLevelRules: false,
      kind: 'name',
      nested: false,
      sourceStart: name.source.indexOf('@med'),
      text: '@med',
    })

    const nestedName = sourceWithCursor([
      "import { styled } from 'yak'",
      'const Value = styled.div`',
      '  @media (min-width: 48rem) {',
      `    @sup${cursorMarker}`,
      '  }',
      '`',
    ])
    expect(
      getAtRuleCompletionContext(nestedName.source, nestedName.cursorOffset, nestedName.template!),
    ).toEqual({
      allowsTopLevelRules: false,
      kind: 'name',
      nested: true,
      sourceStart: nestedName.source.indexOf('@sup'),
      text: '@sup',
    })

    const globalName = sourceWithCursor([
      "import { globalStyle } from 'yak'",
      'const styles = globalStyle`',
      `  @pro${cursorMarker}`,
      '`',
    ])
    expect(
      getAtRuleCompletionContext(globalName.source, globalName.cursorOffset, globalName.template!),
    ).toEqual({
      allowsTopLevelRules: true,
      kind: 'name',
      nested: false,
      sourceStart: globalName.source.indexOf('@pro'),
      text: '@pro',
    })

    const prelude = sourceWithCursor([
      "import { styled } from 'yak'",
      'const Value = styled.div`',
      `  @media ${cursorMarker}`,
      '`',
    ])
    expect(
      getAtRuleCompletionContext(prelude.source, prelude.cursorOffset, prelude.template!),
    ).toEqual({ kind: 'prelude' })

    const groupedRule = sourceWithCursor([
      "import { styled } from 'yak'",
      'const Value = styled.div`',
      '  @media (min-width: 48rem) {',
      `    dis${cursorMarker}`,
      '  }',
      '`',
    ])
    expect(
      getAtRuleCompletionContext(
        groupedRule.source,
        groupedRule.cursorOffset,
        groupedRule.template!,
      ),
    ).toEqual({ kind: 'rule' })

    const descriptor = sourceWithCursor([
      "import { globalStyle } from 'yak'",
      'const Value = globalStyle`',
      '  @property --size {',
      `    syn${cursorMarker}`,
      '  }',
      '`',
    ])
    expect(
      getAtRuleCompletionContext(descriptor.source, descriptor.cursorOffset, descriptor.template!),
    ).toEqual({
      atRuleName: '@property',
      kind: 'descriptor',
      sourceStart: descriptor.source.indexOf('syn'),
      text: 'syn',
    })
  })

  it('rejects at-rule completions in isolated or invalid CSS positions', () => {
    const cases = ['color: @', '/* @med', 'content: "@med', 'background: url(@med']

    for (const line of cases) {
      const found = sourceWithCursor([
        "import { styled } from 'yak'",
        'const Value = styled.div`',
        `  ${line}${cursorMarker}`,
        '`',
      ])

      expect(
        getAtRuleCompletionContext(found.source, found.cursorOffset, found.template!),
      ).toBeUndefined()
    }

    for (const lines of [
      [
        "import { styled } from 'yak'",
        'const Value = styled.div`',
        '  @property --size {',
        `    @med${cursorMarker}`,
        '  }',
        '`',
      ],
      [
        "import { styled } from 'yak'",
        'const Value = styled.div`',
        '  @property --size {',
        `    syn${cursorMarker}`,
        '  }',
        '`',
      ],
      [
        "import { styled } from 'yak'",
        'const Value = styled.div`',
        '  @keyframes spin {',
        `    @med${cursorMarker}`,
        '  }',
        '`',
      ],
      ["import { keyframes } from 'yak'", 'const spin = keyframes`', `  @med${cursorMarker}`, '`'],
    ]) {
      const found = sourceWithCursor(lines)

      expect(getAtRuleCompletionContext(found.source, found.cursorOffset, found.template!)).toEqual(
        { kind: 'blocked' },
      )
    }
  })

  it.each([
    ['.link:ho', '.link:ho'],
    ['&:fo', '&:fo'],
    ['button:dis', 'button:dis'],
  ])('preserves complex selector text for %s pseudo completion', (selector, expectedText) => {
    const found = sourceWithCursor([
      "import { styled } from 'yak'",
      'const Value = styled.div`',
      `  ${selector}${cursorMarker}`,
      '`',
    ])

    expect(getSelectorCompletionContext(found.source, found.cursorOffset, found.template!)).toEqual(
      {
        sourceStart: found.source.indexOf(selector),
        text: expectedText,
      },
    )
  })
})
