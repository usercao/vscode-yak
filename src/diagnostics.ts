import type {
  Diagnostic as CssDiagnostic,
  LanguageService,
  Range as CssRange,
} from 'vscode-css-languageservice'

import type { VirtualCssDocument } from './hover'
import { mapVirtualRangeToSourceOffsets, type Template, type OffsetRange } from './template'

export interface MappedCssDiagnostic {
  diagnostic: CssDiagnostic
  range: OffsetRange
}

export function getMappedCssDiagnostics(
  cssLanguageService: LanguageService,
  template: Template,
  virtualCss: VirtualCssDocument,
): MappedCssDiagnostic[] {
  const stylesheet = cssLanguageService.parseStylesheet(virtualCss.document)

  return cssLanguageService.doValidation(virtualCss.document, stylesheet).flatMap((diagnostic) => {
    const range = mapVirtualCssRangeToTemplateOffsets(
      diagnostic.range,
      template,
      virtualCss,
      diagnostic,
    )

    return range ? [{ diagnostic, range }] : []
  })
}

export function mapVirtualCssRangeToTemplateOffsets(
  range: CssRange,
  template: Template,
  virtualCss: VirtualCssDocument,
  diagnostic?: CssDiagnostic,
): OffsetRange | undefined {
  const virtualStart = virtualCss.document.offsetAt(range.start)
  const virtualEnd = virtualCss.document.offsetAt(range.end)

  if (virtualEnd <= virtualStart) {
    return undefined
  }

  const sourceRange = mapVirtualRangeToSourceOffsets(
    virtualStart,
    virtualEnd,
    virtualCss.prefixLength,
    virtualCss.sourceStart,
    virtualCss.sourceLength,
  )

  if (
    !sourceRange ||
    !isStaticTemplateRange(sourceRange, template, virtualCss) ||
    isInterpolationAdjacentValueDiagnostic(range, template, virtualCss, diagnostic)
  ) {
    return undefined
  }

  return sourceRange
}

export function mapTemplateRangeToVirtualCssRange(
  range: OffsetRange,
  template: Template,
  virtualCss: VirtualCssDocument,
): CssRange | undefined {
  if (!isStaticTemplateRange(range, template, virtualCss)) {
    return undefined
  }

  const virtualStart = virtualCss.prefixLength + range.start - template.bodyStart
  const virtualEnd = virtualCss.prefixLength + range.end - template.bodyStart

  return {
    start: virtualCss.document.positionAt(virtualStart),
    end: virtualCss.document.positionAt(virtualEnd),
  }
}

function isStaticTemplateRange(
  range: OffsetRange,
  template: Template,
  virtualCss: VirtualCssDocument,
) {
  if (
    range.end <= range.start ||
    virtualCss.sourceStart !== template.bodyStart ||
    virtualCss.sourceLength !== template.maskedBody.length ||
    range.start < template.bodyStart ||
    range.end > template.bodyEnd
  ) {
    return false
  }

  const start = range.start - template.bodyStart
  const end = range.end - template.bodyStart

  return !template.interpolations.some(
    (interpolation) => start < interpolation.end && end > interpolation.start,
  )
}

function isInterpolationAdjacentValueDiagnostic(
  range: CssRange,
  template: Template,
  virtualCss: VirtualCssDocument,
  diagnostic: CssDiagnostic | undefined,
) {
  const virtualStart = virtualCss.document.offsetAt(range.start)
  const virtualEnd = virtualCss.document.offsetAt(range.end)
  const start = virtualStart - virtualCss.prefixLength
  const end = virtualEnd - virtualCss.prefixLength

  if (
    diagnostic?.code !== 'css-propertyvalueexpected' ||
    virtualCss.document.getText(range) !== ';'
  ) {
    return false
  }

  return template.interpolations.some(
    (interpolation) =>
      interpolation.end <= start &&
      template.maskedBody.slice(interpolation.end, start).trim() === '' &&
      end === start + 1,
  )
}
