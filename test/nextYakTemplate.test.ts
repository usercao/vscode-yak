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
})
