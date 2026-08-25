import { describe, expect, it } from 'vitest'
import { getCSSLanguageService, type LanguageService } from 'vscode-css-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'

import { getMappedCssHover, type VirtualCssDocument } from '../src/hover'
import { createVirtualCssText, findTemplate, type Template } from '../src/template'

const cursorMarker = '/*cursor*/'
const cssLanguageService = getCSSLanguageService()

function hoverAtCursor(sourceWithCursor: string) {
  const cursorOffset = sourceWithCursor.indexOf(cursorMarker)

  if (cursorOffset === -1) {
    throw new Error(`Missing ${cursorMarker} marker`)
  }

  const source = sourceWithCursor.replace(cursorMarker, '')
  const template = findTemplate(source, cursorOffset, 'typescriptreact', '/fixture.tsx')

  if (!template) {
    return { hover: undefined, source, template: undefined }
  }

  return {
    hover: getMappedCssHover(
      cssLanguageService,
      cursorOffset,
      template,
      createVirtualDocument(source, template),
    ),
    source,
    template,
  }
}

function createVirtualDocument(source: string, template: Template): VirtualCssDocument {
  const virtualCssText = createVirtualCssText(template)

  return {
    document: TextDocument.create('yak:test', 'css', 1, virtualCssText.text),
    prefixLength: virtualCssText.prefixLength,
    sourceLength: template.maskedBody.length,
    sourceStart: template.bodyStart,
  }
}

function styledSource(css: string): string {
  return ["import { styled } from 'next-yak'", 'const Panel = styled.div`', `  ${css}`, '`'].join(
    '\n',
  )
}

function hoverMarkdownValue(hover: ReturnType<typeof hoverAtCursor>['hover']): string | undefined {
  if (!hover) {
    return undefined
  }

  const first = Array.isArray(hover.contents) ? hover.contents[0] : hover.contents

  return typeof first === 'string' ? first : 'value' in first ? first.value : undefined
}

describe('yak CSS hover', () => {
  it('maps property hover Markdown and its full declaration range back to the host document', () => {
    const source = styledSource('display/*cursor*/: grid;')
    const result = hoverAtCursor(source)

    expect(hoverMarkdownValue(result.hover)).toContain('MDN Reference')
    expect(hoverMarkdownValue(result.hover)).toContain('display')
    expect(result.source.slice(result.hover?.range.start, result.hover?.range.end)).toBe(
      'display: grid',
    )
  })

  it('returns dedicated CSS data documentation for static values and functions', () => {
    const value = hoverAtCursor(styledSource('display: gr/*cursor*/id;')).hover
    const functionHover = hoverAtCursor(styledSource('transform: rot/*cursor*/ate(45deg);')).hover

    expect(hoverMarkdownValue(value)).toContain('grid formatting context')
    expect(hoverMarkdownValue(functionHover)).toContain('2D rotation')
  })

  it('returns dedicated documentation for pseudo-classes and pseudo-elements', () => {
    const pseudoClass = hoverAtCursor(styledSource('a:ho/*cursor*/ver { color: red; }')).hover
    const pseudoElement = hoverAtCursor(styledSource('a::bef/*cursor*/ore { color: red; }')).hover

    expect(hoverMarkdownValue(pseudoClass)).toContain('pointing device')
    expect(hoverMarkdownValue(pseudoClass)).toContain('MDN')
    expect(hoverMarkdownValue(pseudoElement)).toContain('styleable child pseudo-element')
    expect(hoverMarkdownValue(pseudoElement)).toContain('MDN')
  })

  it('returns property hover inside keyframes but not for keyframe selectors', () => {
    const property = hoverAtCursor(
      [
        "import { keyframes } from 'next-yak'",
        'const fade = keyframes`',
        '  from {',
        '    op/*cursor*/acity: 0;',
        '  }',
        '`',
      ].join('\n'),
    ).hover
    const keyframeSelector = hoverAtCursor(
      [
        "import { keyframes } from 'next-yak'",
        'const fade = keyframes`',
        '  fr/*cursor*/om {',
        '    opacity: 0;',
        '  }',
        '`',
      ].join('\n'),
    ).hover

    expect(hoverMarkdownValue(property)).toContain('MDN Reference')
    expect(keyframeSelector).toBeUndefined()
  })

  it('does not surface hover for interpolations, wrapper-only ranges, or invalid CSS positions', () => {
    const interpolation = hoverAtCursor(styledSource('color: ${theme./*cursor*/accent};')).hover
    const invalid = hoverAtCursor(styledSource('@unknown/*cursor*/ rule;')).hover

    const sourceWithCursor = styledSource('color/*cursor*/: red;')
    const cursorOffset = sourceWithCursor.indexOf(cursorMarker)
    const source = sourceWithCursor.replace(cursorMarker, '')
    const template = findTemplate(source, cursorOffset, 'typescriptreact', '/fixture.tsx')

    if (!template) {
      throw new Error('Expected a static yak template')
    }

    const virtualCss = createVirtualDocument(source, template)
    const wrapperOnlyService: LanguageService = {
      ...cssLanguageService,
      doHover: () => ({
        contents: { kind: 'markdown' as const, value: 'wrapper only' },
        range: {
          start: virtualCss.document.positionAt(0),
          end: virtualCss.document.positionAt(1),
        },
      }),
      parseStylesheet: () => ({}),
    }
    const wrapperOnly = getMappedCssHover(wrapperOnlyService, cursorOffset, template, virtualCss)

    expect(interpolation).toBeUndefined()
    expect(invalid).toBeUndefined()
    expect(wrapperOnly).toBeUndefined()
  })
})
