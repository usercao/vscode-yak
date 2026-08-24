import { describe, expect, it } from 'vitest'
import {
  createVirtualCssText,
  findNextYakTemplate,
  getSelectorCompletionContext,
  mapVirtualRangeToSourceOffsets,
} from '../src/nextYakTemplate'

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
    template: findNextYakTemplate(sourceWithoutCursor, cursorOffset, languageId, '/fixture.tsx'),
  }
}

function styledSource(tagExpression: string, importStatement = "import { styled } from 'next-yak'") {
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

function expectTemplateTag(source: string, expectedTag: 'styled' | 'css' | 'globalStyle' | 'keyframes', languageId = 'typescriptreact') {
  expect(findTemplateAtCursor(source, languageId).template?.tag).toBe(expectedTag)
}

describe('findNextYakTemplate', () => {
  it.each([
    ['styled', 'styled.div'],
    ['css', 'css'],
    ['globalStyle', 'globalStyle'],
    ['keyframes', 'keyframes'],
  ])('recognizes direct next-yak %s imports', (expectedTag, tagExpression) => {
    const { template } = findTemplateAtCursor(
      styledSource(
        tagExpression,
        "import { css, globalStyle, keyframes, styled } from 'next-yak'",
      ),
    )

    expect(template?.tag).toBe(expectedTag)
  })

  it('recognizes aliases and namespace imports', () => {
    expect(
      findTemplateAtCursor(
        styledSource('s.div', "import { styled as s } from 'next-yak'"),
      ).template?.tag,
    ).toBe('styled')
    expect(
      findTemplateAtCursor(
        styledSource('rules', "import { css as rules } from 'next-yak'"),
      ).template?.tag,
    ).toBe('css')
    expect(
      findTemplateAtCursor(
        styledSource('yak.styled.a', "import * as yak from 'next-yak'"),
      ).template?.tag,
    ).toBe('styled')
    expect(
      findTemplateAtCursor(
        styledSource('yak.css', "import * as yak from 'next-yak'"),
      ).template?.tag,
    ).toBe('css')
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
      "import { css, styled } from 'next-yak'",
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
        "import { css } from 'next-yak'",
        'const view = <section css={css`',
        `  display: grid;${cursorMarker}`,
        '`} />',
      ].join('\n'),
      'css',
    )
  })

  it('locates the correct template among adjacent and separate templates', () => {
    const source = [
      "import { css, styled } from 'next-yak'",
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
    expectTemplateTag(styledSource("yak.styled['section']", "import * as yak from 'next-yak'"), 'styled')

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
    expect(findTemplateAtCursor(styledSource('styled.div', "import type { styled } from 'next-yak'")).template).toBeUndefined()
    expect(findTemplateAtCursor(styledSource('styled.div', "import { type styled } from 'next-yak'")).template).toBeUndefined()
    expect(findTemplateAtCursor(styledSource('yak.styled.div', "import type * as yak from 'next-yak'")).template).toBeUndefined()

    expect(findTemplateAtCursor(styledSource(
      'styled.div',
      [
        "import type { styled } from 'next-yak'",
        "import { styled } from 'next-yak'",
      ].join('\n'),
    )).template).toBeUndefined()

    expectTemplateTag(
      styledSource(
        's.div',
        [
          "import type { styled as StyledType } from 'next-yak'",
          "import { styled as s } from 'next-yak'",
        ].join('\n'),
      ),
      'styled',
    )

    expectTemplateTag(
      styledSource(
        's.div',
        [
          "import { styled } from 'next-yak'",
          "import { styled as s } from 'next-yak'",
        ].join('\n'),
      ),
      'styled',
    )

    expect(findTemplateAtCursor(styledSource('styled.div', "import { styled as } from 'next-yak'")).template).toBeUndefined()
  })

  it('does not handle similarly named tags from another module or local bindings', () => {
    expect(
      findTemplateAtCursor(
        styledSource('styled.div', "import { styled } from 'another-library'"),
      ).template,
    ).toBeUndefined()

    const source = [
      "import { styled } from 'next-yak'",
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
      "import { styled } from 'next-yak'",
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

    const interpolationSource = source.replace('background: red;/*cursor*/', 'background: ${/*cursor*/accent};')
    expect(findTemplateAtCursor(interpolationSource).template).toBeUndefined()
  })

  it('preserves multiline nested interpolations while locating later static CSS', () => {
    const source = [
      "import { css, styled } from 'next-yak'",
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
      "import { styled } from 'next-yak'",
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
      "import { styled } from 'next-yak'",
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
      "import { styled } from 'next-yak'",
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
      "import { styled } from 'next-yak'",
      'const Panel = styled.div`',
      '  color: ${accent};',
      `  background: blue;${cursorMarker}`,
      '`',
    ].join('\r\n')
    const found = findTemplateAtCursor(source)
    const { template } = found
    const body = found.source.slice(template?.bodyStart, (template?.bodyStart ?? 0) + (template?.maskedBody.length ?? 0))

    expect(template?.maskedBody).toContain('\r\n')
    expect(template?.maskedBody.match(/\r\n/g)?.length).toBe(body.match(/\r\n/g)?.length)
    expect(template?.maskedBody.length).toBe(body.length)
  })

  it('does not throw for incomplete templates, interpolations, or malformed TSX', () => {
    const cases = [
      [
        "import { styled } from 'next-yak'",
        'const Panel = styled.div`',
        `  color: re${cursorMarker}`,
      ],
      [
        "import { styled } from 'next-yak'",
        'const Panel = styled.div`',
        `  color: \${({ theme }) => theme.${cursorMarker}`,
      ],
      [
        "import { styled } from 'next-yak'",
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
      "import { styled } from 'next-yak'",
      'const Panel = styled.div`',
      `  color: \${({ theme }) => theme.${cursorMarker}`,
    ])
    const unfinishedTemplate = sourceWithCursor([
      "import { styled } from 'next-yak'",
      'const Panel = styled.div`',
      `  col${cursorMarker}`,
    ])

    expect(unfinishedInterpolation.template).toBeUndefined()
    expect(unfinishedTemplate.template?.tag).toBe('styled')
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
      "import { styled } from 'next-yak'",
      'const Link = styled.a`',
      `  a:${cursorMarker}`,
      '`',
    ].join('\n')
    const found = findTemplateAtCursor(source)

    expect(found.template).toBeDefined()
    expect(getSelectorCompletionContext(found.source, found.cursorOffset, found.template!)).toEqual({
      sourceStart: found.source.indexOf('a:'),
      text: 'a:',
    })
  })

  it('does not extract selectors from at-rules, interpolations, or completed rules', () => {
    const cases = [
      '@media',
      'a:hover {',
      '${value}',
    ]

    for (const line of cases) {
      const found = sourceWithCursor([
        "import { styled } from 'next-yak'",
        'const Value = styled.div`',
        `  ${line}${cursorMarker}`,
        '`',
      ])

      expect(found.template).toBeDefined()
      expect(getSelectorCompletionContext(found.source, found.cursorOffset, found.template!)).toBeUndefined()
    }
  })

  it.each([
    ['.link:ho', '.link:ho'],
    ['&:fo', '&:fo'],
    ['button:dis', 'button:dis'],
  ])('preserves complex selector text for %s pseudo completion', (selector, expectedText) => {
    const found = sourceWithCursor([
      "import { styled } from 'next-yak'",
      'const Value = styled.div`',
      `  ${selector}${cursorMarker}`,
      '`',
    ])

    expect(getSelectorCompletionContext(found.source, found.cursorOffset, found.template!)).toEqual({
      sourceStart: found.source.indexOf(selector),
      text: expectedText,
    })
  })
})
