import { describe, expect, it } from 'vitest'
import {
  getCSSLanguageService,
  type ColorInformation as CssColorInformation,
  type ColorPresentation as CssColorPresentation,
  type LanguageService,
} from 'vscode-css-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'

import {
  getMappedCssColorPresentations,
  getMappedCssColors,
  mapVirtualCssColorPresentation,
} from '../src/colors'
import type { VirtualCssDocument } from '../src/hover'
import { createVirtualCssText, findTemplate, type Template } from '../src/template'

const cssLanguageService = getCSSLanguageService()

function createVirtualDocument(template: Template): VirtualCssDocument {
  const virtualCssText = createVirtualCssText(template)

  return {
    document: TextDocument.create('yak:test', 'css', 1, virtualCssText.text),
    prefixLength: virtualCssText.prefixLength,
    sourceLength: template.maskedBody.length,
    sourceStart: template.bodyStart,
  }
}

function getTemplate(source: string, needle: string): Template {
  const template = findTemplate(source, source.indexOf(needle), 'typescriptreact', '/fixture.tsx')

  if (!template) {
    throw new Error(`Expected a template at ${needle}`)
  }

  return template
}

function styledSource(css: string): string {
  return ["import { styled } from 'next-yak'", 'const Panel = styled.div`', `  ${css}`, '`'].join(
    '\n',
  )
}

function colorInformation(
  virtualCss: VirtualCssDocument,
  start: number,
  end: number,
): CssColorInformation {
  return {
    color: { alpha: 1, blue: 0, green: 0, red: 1 },
    range: {
      start: virtualCss.document.positionAt(start),
      end: virtualCss.document.positionAt(end),
    },
  }
}

describe('yak CSS colors', () => {
  it('maps static hex, alpha, named, and gradient colors while excluding interpolations, comments, and strings', () => {
    const source = styledSource(
      [
        'color: #176b5b;',
        '  outline-color: rgba(23, 107, 91, 0.5);',
        '  border-color: rebeccapurple;',
        '  background: linear-gradient(#fff, hsl(160 45% 26%));',
        '  /* #ff0000 */',
        '  content: "#00ff00";',
        '  color: ${theme.accent};',
      ].join('\n  '),
    )
    const template = getTemplate(source, '#176b5b')
    const colors = getMappedCssColors(cssLanguageService, template, createVirtualDocument(template))

    expect(colors.map((color) => source.slice(color.range.start, color.range.end))).toEqual([
      '#176b5b',
      'rgba(23, 107, 91, 0.5)',
      'rebeccapurple',
      '#fff',
      'hsl(160 45% 26%)',
    ])
    expect(
      colors.find(
        (color) => source.slice(color.range.start, color.range.end) === 'rgba(23, 107, 91, 0.5)',
      )?.color.alpha,
    ).toBe(0.5)
  })

  it('maps CSS Language Service color presentations back to the named source color', () => {
    const source = styledSource('color: rebeccapurple;')
    const template = getTemplate(source, 'rebeccapurple')
    const virtualCss = createVirtualDocument(template)
    const namedColor = getMappedCssColors(cssLanguageService, template, virtualCss)[0]
    const presentations = getMappedCssColorPresentations(
      cssLanguageService,
      namedColor.color,
      namedColor.range,
      template,
      virtualCss,
    )

    expect(presentations.map((presentation) => presentation.label)).toEqual(
      expect.arrayContaining([
        'rgb(102, 51, 153)',
        '#663399',
        'hsl(270, 50%, 40%)',
        'rebeccapurple',
      ]),
    )
    expect(
      presentations.every(
        (presentation) =>
          source.slice(presentation.textEdit.range.start, presentation.textEdit.range.end) ===
          'rebeccapurple',
      ),
    ).toBe(true)
  })

  it('only adds a named-color presentation for an opaque exact RGB match', () => {
    const source = styledSource('color: rgba(102, 51, 153, 0.5);')
    const template = getTemplate(source, 'rgba')
    const virtualCss = createVirtualDocument(template)
    const alphaColor = getMappedCssColors(cssLanguageService, template, virtualCss)[0]
    const presentations = getMappedCssColorPresentations(
      cssLanguageService,
      alphaColor.color,
      alphaColor.range,
      template,
      virtualCss,
    )

    expect(presentations.map((presentation) => presentation.label)).not.toContain('rebeccapurple')
  })

  it('does not round a near-match RGB color into a named-color presentation', () => {
    const source = styledSource('color: rgb(102.1, 51, 153);')
    const template = getTemplate(source, 'rgb')
    const virtualCss = createVirtualDocument(template)
    const color = getMappedCssColors(cssLanguageService, template, virtualCss)[0]
    const presentations = getMappedCssColorPresentations(
      cssLanguageService,
      color.color,
      color.range,
      template,
      virtualCss,
    )

    expect(presentations.map((presentation) => presentation.label)).not.toContain('rebeccapurple')
  })

  it('rejects color information and presentations that touch comments, strings, interpolations, or wrappers', () => {
    const source = styledSource(
      [
        'color: #176b5b;',
        '  /* #ff0000 */',
        '  content: "#00ff00";',
        '  color: ${theme.accent};',
      ].join('\n  '),
    )
    const template = getTemplate(source, '#176b5b')
    const virtualCss = createVirtualDocument(template)
    const staticStart = virtualCss.prefixLength + template.maskedBody.indexOf('#176b5b')
    const commentStart = virtualCss.prefixLength + template.maskedBody.indexOf('#ff0000')
    const stringStart = virtualCss.prefixLength + template.maskedBody.indexOf('#00ff00')
    const interpolation = template.interpolations[0]
    const service: LanguageService = {
      ...cssLanguageService,
      findDocumentColors: () => [
        colorInformation(virtualCss, staticStart, staticStart + '#176b5b'.length),
        colorInformation(virtualCss, commentStart, commentStart + '#ff0000'.length),
        colorInformation(virtualCss, stringStart, stringStart + '#00ff00'.length),
        colorInformation(
          virtualCss,
          virtualCss.prefixLength + interpolation.start,
          virtualCss.prefixLength + interpolation.end,
        ),
        colorInformation(virtualCss, virtualCss.prefixLength - 1, virtualCss.prefixLength),
      ],
      parseStylesheet: () => ({}),
    }
    const colors = getMappedCssColors(service, template, virtualCss)
    const unsafePresentation: CssColorPresentation = {
      label: 'unsafe',
      textEdit: {
        newText: '#ff0000',
        range: colorInformation(virtualCss, commentStart, commentStart + '#ff0000'.length).range,
      },
    }

    expect(colors).toHaveLength(1)
    expect(source.slice(colors[0].range.start, colors[0].range.end)).toBe('#176b5b')
    expect(mapVirtualCssColorPresentation(unsafePresentation, template, virtualCss)).toEqual([])
  })
})
