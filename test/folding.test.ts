import { describe, expect, it } from 'vitest'

import { getCssFoldingRanges } from '../src/foldingRanges'
import { findTemplate } from '../src/template'

function getRanges(source: string, staticCssAnchor: string) {
  const template = findTemplate(
    source,
    source.indexOf(staticCssAnchor),
    'typescriptreact',
    '/fixture.tsx',
  )

  if (!template) {
    throw new Error('Expected a recognized CSS template')
  }

  return getCssFoldingRanges(source, template).map((range) => [range.start, range.end])
}

describe('yak CSS folding', () => {
  it('returns nested ranges for multiline CSS blocks', () => {
    const source = [
      "import { styled } from 'next-yak'",
      'const Panel = styled.section`',
      '  h2 {',
      '    color: red;',
      '    @media (min-width: 48rem) {',
      '      color: blue;',
      '    }',
      '  }',
      '`',
    ].join('\n')

    expect(getRanges(source, 'color: red')).toEqual([
      [4, 6],
      [2, 7],
    ])
  })

  it('returns ranges for multiline keyframe steps', () => {
    const source = [
      "import { keyframes } from 'next-yak'",
      'const fade = keyframes`',
      '  from {',
      '    opacity: 0;',
      '  }',
      '  to {',
      '    opacity: 1;',
      '  }',
      '`',
    ].join('\n')

    expect(getRanges(source, 'opacity: 0')).toEqual([
      [2, 4],
      [5, 7],
    ])
  })

  it('ignores braces in interpolations, comments, and CSS strings', () => {
    const source = [
      "import { styled } from 'next-yak'",
      'const Panel = styled.section`',
      '  h2 {',
      '    content: "}";',
      '    /* { */',
      '    color: ${theme => theme.colors.primary};',
      '  }',
      '`',
    ].join('\n')

    expect(getRanges(source, 'content:')).toEqual([[2, 6]])
  })
})
