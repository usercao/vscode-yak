import { describe, expect, it } from 'vitest'
import { getNextYakStaticHighlightRanges } from '../src/nextYakStaticHighlight'
import { NextYakStaticTemplateCache } from '../src/nextYakTemplate'

function staticHighlightText(source: string) {
  const document = {
    fileName: '/fixture.tsx',
    languageId: 'typescriptreact',
    source,
    uri: 'file:///fixture.tsx',
    version: 1,
  }
  const ranges = getNextYakStaticHighlightRanges(document, new NextYakStaticTemplateCache())

  return ranges.map((range) => source.slice(range.start, range.end)).join('')
}

describe('next-yak static template highlights', () => {
  it('marks explicit static next-yak template forms without parsing imports', () => {
    const source = [
      "import { styled } from 'another-library'",
      'const Panel = styled.div<Props>`',
      '  color: red;',
      '`',
      'const Namespaced = other.styled.div`',
      '  background: blue;',
      '`',
    ].join('\n')

    expect(staticHighlightText(source)).toContain('styled.div<Props>')
    expect(staticHighlightText(source)).toContain('other.styled.div')
    expect(staticHighlightText(source)).not.toContain('color: red;')
    expect(staticHighlightText(source)).not.toContain('background: blue;')
  })

  it('marks the static tag without including template CSS or interpolations', () => {
    const source = [
      'const Panel = yak.styled.div`',
      '  color: ${theme.accent};',
      '  background: blue;',
      '`',
    ].join('\n')
    const highlighted = staticHighlightText(source)

    expect(highlighted).toContain('styled.div')
    expect(highlighted).not.toContain('color: ')
    expect(highlighted).not.toContain('background: blue;')
    expect(highlighted).not.toContain('theme.accent')
    expect(highlighted).not.toContain('${')
  })
})
