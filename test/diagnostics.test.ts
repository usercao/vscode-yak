import { describe, expect, it } from 'vitest'
import {
  getCSSLanguageService,
  type Diagnostic as CssDiagnostic,
  type LanguageService,
} from 'vscode-css-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'

import { getMappedCssDiagnostics, mapTemplateRangeToVirtualCssRange } from '../src/diagnostics'
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
  const cursorOffset = source.indexOf(needle)
  const template = findTemplate(source, cursorOffset, 'typescriptreact', '/fixture.tsx')

  if (!template) {
    throw new Error(`Expected a template at ${needle}`)
  }

  return template
}

function styledSource(css: string): string {
  return ["import { styled } from 'yak'", 'const Panel = styled.div`', `  ${css}`, '`'].join('\n')
}

function cssDiagnostic(
  virtualCss: VirtualCssDocument,
  start: number,
  end: number,
  message: string,
): CssDiagnostic {
  return {
    code: 'test-diagnostic',
    message,
    range: {
      start: virtualCss.document.positionAt(start),
      end: virtualCss.document.positionAt(end),
    },
    severity: 1,
    source: 'css',
  }
}

describe('yak CSS diagnostics', () => {
  it('maps CSS Language Service diagnostics from static template text back to the host document', () => {
    const source = styledSource('colro: red;')
    const template = getTemplate(source, 'colro')
    const diagnostics = getMappedCssDiagnostics(
      cssLanguageService,
      template,
      createVirtualDocument(template),
    )

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].diagnostic.code).toBe('unknownProperties')
    expect(source.slice(diagnostics[0].range.start, diagnostics[0].range.end)).toBe('colro')
  })

  it('keeps diagnostics after an interpolation when their complete range is static', () => {
    const source = styledSource('color: ${theme.accent};\n  colro: red;')
    const template = getTemplate(source, 'colro')
    const diagnostics = getMappedCssDiagnostics(
      cssLanguageService,
      template,
      createVirtualDocument(template),
    )

    expect(diagnostics).toHaveLength(1)
    expect(source.slice(diagnostics[0].range.start, diagnostics[0].range.end)).toBe('colro')
  })

  it('retains a static empty-value diagnostic that does not follow an interpolation', () => {
    const source = styledSource('color: ;')
    const template = getTemplate(source, 'color')
    const diagnostics = getMappedCssDiagnostics(
      cssLanguageService,
      template,
      createVirtualDocument(template),
    )

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].diagnostic.code).toBe('css-propertyvalueexpected')
    expect(source.slice(diagnostics[0].range.start, diagnostics[0].range.end)).toBe(';')
  })

  it('maps missing-semicolon and unclosed-value diagnostics from static CSS', () => {
    const missingSemicolonSource = styledSource('color: red\n  background: blue;')
    const missingSemicolonTemplate = getTemplate(missingSemicolonSource, 'color')
    const missingSemicolonDiagnostics = getMappedCssDiagnostics(
      cssLanguageService,
      missingSemicolonTemplate,
      createVirtualDocument(missingSemicolonTemplate),
    )
    const unclosedValueSource = styledSource('color: rgb(1, 2, 3;')
    const unclosedValueTemplate = getTemplate(unclosedValueSource, 'color')
    const unclosedValueDiagnostics = getMappedCssDiagnostics(
      cssLanguageService,
      unclosedValueTemplate,
      createVirtualDocument(unclosedValueTemplate),
    )

    expect(
      missingSemicolonDiagnostics.some(
        (diagnostic) => diagnostic.diagnostic.code === 'css-semicolonexpected',
      ),
    ).toBe(true)
    expect(
      missingSemicolonDiagnostics.some(
        (diagnostic) =>
          missingSemicolonSource.slice(diagnostic.range.start, diagnostic.range.end) === ':',
      ),
    ).toBe(true)
    expect(unclosedValueDiagnostics).toHaveLength(1)
    expect(unclosedValueDiagnostics[0].diagnostic.code).toBe('css-rparentexpected')
    expect(
      unclosedValueSource.slice(
        unclosedValueDiagnostics[0].range.start,
        unclosedValueDiagnostics[0].range.end,
      ),
    ).toBe(';')
  })

  it('preserves static diagnostics inside nested rules and keyframes', () => {
    const nestedSource = styledSource('&:hover {\n    colro: red;\n  }')
    const nestedTemplate = getTemplate(nestedSource, 'colro')
    const keyframesSource = [
      "import { keyframes } from 'yak'",
      'const fade = keyframes`',
      '  from { opacity: rgb(1, 2, 3; }',
      '`',
    ].join('\n')
    const keyframesTemplate = getTemplate(keyframesSource, 'opacity')

    const nestedDiagnostics = getMappedCssDiagnostics(
      cssLanguageService,
      nestedTemplate,
      createVirtualDocument(nestedTemplate),
    )
    const keyframesDiagnostics = getMappedCssDiagnostics(
      cssLanguageService,
      keyframesTemplate,
      createVirtualDocument(keyframesTemplate),
    )

    expect(nestedDiagnostics).toHaveLength(1)
    expect(
      nestedSource.slice(nestedDiagnostics[0].range.start, nestedDiagnostics[0].range.end),
    ).toBe('colro')
    expect(keyframesDiagnostics).toHaveLength(1)
    expect(keyframesDiagnostics[0].diagnostic.code).toBe('css-rparentexpected')
    expect(
      keyframesSource.slice(keyframesDiagnostics[0].range.start, keyframesDiagnostics[0].range.end),
    ).toBe(';')
  })

  it('rejects diagnostics that touch interpolations or synthetic wrappers', () => {
    const source = styledSource('color: ${theme.accent};\n  display: grid;')
    const template = getTemplate(source, 'display')
    const virtualCss = createVirtualDocument(template)
    const interpolation = template.interpolations[0]
    const displayStart = virtualCss.prefixLength + template.maskedBody.indexOf('display')
    const diagnostics = [
      cssDiagnostic(virtualCss, virtualCss.prefixLength - 1, virtualCss.prefixLength, 'prefix'),
      cssDiagnostic(
        virtualCss,
        virtualCss.prefixLength + interpolation.start,
        virtualCss.prefixLength + interpolation.end,
        'interpolation',
      ),
      cssDiagnostic(
        virtualCss,
        virtualCss.prefixLength + template.maskedBody.length,
        virtualCss.prefixLength + template.maskedBody.length + 1,
        'suffix',
      ),
      cssDiagnostic(virtualCss, displayStart, displayStart + 'display'.length, 'static'),
    ]
    const service: LanguageService = {
      ...cssLanguageService,
      doValidation: () => diagnostics,
      parseStylesheet: () => ({}),
    }

    const mapped = getMappedCssDiagnostics(service, template, virtualCss)

    expect(mapped).toHaveLength(1)
    expect(mapped[0].diagnostic.message).toBe('static')
    expect(source.slice(mapped[0].range.start, mapped[0].range.end)).toBe('display')
  })

  it('only maps non-empty static host ranges back into virtual CSS', () => {
    const source = styledSource('color: ${theme.accent};\n  display: grid;')
    const template = getTemplate(source, 'display')
    const virtualCss = createVirtualDocument(template)
    const displayStart = source.indexOf('display')
    const interpolation = template.interpolations[0]

    const mapped = mapTemplateRangeToVirtualCssRange(
      { start: displayStart, end: displayStart + 'display'.length },
      template,
      virtualCss,
    )

    expect(mapped).toBeDefined()
    expect(virtualCss.document.getText(mapped)).toBe('display')
    expect(
      mapTemplateRangeToVirtualCssRange(
        {
          start: template.bodyStart + interpolation.start,
          end: template.bodyStart + interpolation.end,
        },
        template,
        virtualCss,
      ),
    ).toBeUndefined()
    expect(
      mapTemplateRangeToVirtualCssRange(
        { start: displayStart, end: displayStart },
        template,
        virtualCss,
      ),
    ).toBeUndefined()
  })
})
