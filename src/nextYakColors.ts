import type {
  Color as CssColor,
  ColorInformation as CssColorInformation,
  ColorPresentation as CssColorPresentation,
  LanguageService,
  TextEdit as CssTextEdit,
} from 'vscode-css-languageservice'
import colorNames from 'color-name'
import { mapTemplateRangeToVirtualCssRange, mapVirtualCssRangeToTemplateOffsets } from './nextYakDiagnostics'
import type { VirtualCssDocument } from './nextYakHover'
import type { NextYakTemplate, OffsetRange } from './nextYakTemplate'

export interface NextYakCssColor {
  color: CssColor
  range: OffsetRange
}

export interface NextYakCssColorTextEdit {
  newText: string
  range: OffsetRange
}

export interface NextYakCssColorPresentation {
  additionalTextEdits?: readonly NextYakCssColorTextEdit[]
  label: string
  textEdit: NextYakCssColorTextEdit
}

export function getNextYakCssColors(
  cssLanguageService: LanguageService,
  template: NextYakTemplate,
  virtualCss: VirtualCssDocument,
): NextYakCssColor[] {
  const stylesheet = cssLanguageService.parseStylesheet(virtualCss.document)

  return cssLanguageService.findDocumentColors(virtualCss.document, stylesheet)
    .flatMap((colorInformation) => mapVirtualCssColorInformation(colorInformation, template, virtualCss))
}

export function getNextYakCssColorPresentations(
  cssLanguageService: LanguageService,
  color: CssColor,
  range: OffsetRange,
  template: NextYakTemplate,
  virtualCss: VirtualCssDocument,
): NextYakCssColorPresentation[] {
  if (!isCssColorRange(range, template)) {
    return []
  }

  const virtualRange = mapTemplateRangeToVirtualCssRange(range, template, virtualCss)

  if (!virtualRange) {
    return []
  }

  const stylesheet = cssLanguageService.parseStylesheet(virtualCss.document)

  const presentations = cssLanguageService.getColorPresentations(
    virtualCss.document,
    stylesheet,
    color,
    virtualRange,
  ).flatMap((presentation) => mapVirtualCssColorPresentation(presentation, template, virtualCss))
  const namedColorPresentation = getNamedColorPresentation(color, virtualRange, template, virtualCss)

  return namedColorPresentation ? [...presentations, namedColorPresentation] : presentations
}

export function mapVirtualCssColorInformation(
  colorInformation: CssColorInformation,
  template: NextYakTemplate,
  virtualCss: VirtualCssDocument,
): NextYakCssColor[] {
  const range = mapVirtualCssColorRangeToTemplateOffsets(colorInformation.range, template, virtualCss)

  return range ? [{ color: colorInformation.color, range }] : []
}

export function mapVirtualCssColorPresentation(
  presentation: CssColorPresentation,
  template: NextYakTemplate,
  virtualCss: VirtualCssDocument,
): NextYakCssColorPresentation[] {
  if (!presentation.textEdit) {
    return []
  }

  const textEdit = mapVirtualCssColorTextEdit(presentation.textEdit, template, virtualCss)
  const additionalTextEdits = (presentation.additionalTextEdits ?? []).flatMap((edit) => {
    const mappedEdit = mapVirtualCssColorTextEdit(edit, template, virtualCss)

    return mappedEdit ? [mappedEdit] : []
  })

  if (
    !textEdit
    || additionalTextEdits.length !== (presentation.additionalTextEdits?.length ?? 0)
    || hasOverlappingEdits([textEdit, ...additionalTextEdits])
  ) {
    return []
  }

  return [{
    ...(additionalTextEdits.length > 0 ? { additionalTextEdits } : {}),
    label: presentation.label,
    textEdit,
  }]
}

function mapVirtualCssColorTextEdit(
  edit: CssTextEdit,
  template: NextYakTemplate,
  virtualCss: VirtualCssDocument,
): NextYakCssColorTextEdit | undefined {
  const range = mapVirtualCssColorRangeToTemplateOffsets(edit.range, template, virtualCss)

  return range ? { newText: edit.newText, range } : undefined
}

function mapVirtualCssColorRangeToTemplateOffsets(
  range: CssColorInformation['range'],
  template: NextYakTemplate,
  virtualCss: VirtualCssDocument,
): OffsetRange | undefined {
  const sourceRange = mapVirtualCssRangeToTemplateOffsets(range, template, virtualCss)

  return sourceRange && isCssColorRange(sourceRange, template) ? sourceRange : undefined
}

function getNamedColorPresentation(
  color: CssColor,
  virtualRange: CssColorInformation['range'],
  template: NextYakTemplate,
  virtualCss: VirtualCssDocument,
): NextYakCssColorPresentation | undefined {
  if (color.alpha !== 1) {
    return undefined
  }

  const name = findColorName(color)
  const range = mapVirtualCssColorRangeToTemplateOffsets(virtualRange, template, virtualCss)

  return name && range ? {
    label: name,
    textEdit: { newText: name, range },
  } : undefined
}

function findColorName(color: CssColor) {
  const red = toExactColorByte(color.red)
  const green = toExactColorByte(color.green)
  const blue = toExactColorByte(color.blue)

  if (red === undefined || green === undefined || blue === undefined) {
    return undefined
  }

  return Object.entries(colorNames).find(([, value]) => (
    value[0] === red && value[1] === green && value[2] === blue
  ))?.[0]
}

function toExactColorByte(channel: number) {
  const byte = channel * 255
  const roundedByte = Math.round(byte)

  return Math.abs(byte - roundedByte) < 0.000_001 ? roundedByte : undefined
}

function isCssColorRange(range: OffsetRange, template: NextYakTemplate) {
  const start = range.start - template.bodyStart
  const end = range.end - template.bodyStart

  if (start < 0 || end > template.maskedBody.length || end <= start) {
    return false
  }

  return !getCssProtectedRanges(template.maskedBody).some((protectedRange) => (
    start < protectedRange.end && end > protectedRange.start
  ))
}

function getCssProtectedRanges(text: string): OffsetRange[] {
  const ranges: OffsetRange[] = []
  let offset = 0

  while (offset < text.length) {
    if (text[offset] === '/' && text[offset + 1] === '*') {
      const start = offset
      const end = text.indexOf('*/', offset + 2)

      offset = end === -1 ? text.length : end + 2
      ranges.push({ start, end: offset })
      continue
    }

    if (text[offset] === '"' || text[offset] === "'") {
      const start = offset
      const quote = text[offset]

      offset += 1

      while (offset < text.length) {
        if (text[offset] === '\\') {
          offset += 2
        } else if (text[offset] === quote) {
          offset += 1
          break
        } else {
          offset += 1
        }
      }

      ranges.push({ start, end: Math.min(offset, text.length) })
      continue
    }

    offset += 1
  }

  return ranges
}

function hasOverlappingEdits(edits: readonly NextYakCssColorTextEdit[]) {
  const ordered = [...edits].sort((left, right) => left.range.start - right.range.start)

  return ordered.some((edit, index) => index > 0 && ordered[index - 1].range.end > edit.range.start)
}
