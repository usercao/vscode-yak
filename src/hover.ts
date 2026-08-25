import {
  getDefaultCSSDataProvider,
  type Hover as CssHover,
  type IPropertyData,
  type IValueData,
  type LanguageService,
  type MarkupContent,
  type Range as CssRange,
} from 'vscode-css-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  mapVirtualRangeToSourceOffsets,
  type Template,
  type OffsetRange,
} from './template'

export interface VirtualCssDocument {
  document: TextDocument
  prefixLength: number
  sourceLength: number
  sourceStart: number
}

export interface MappedCssHover {
  contents: CssHover['contents']
  range: OffsetRange
}

interface CssDataEntry {
  description?: string | MarkupContent
  references?: readonly { name: string; url: string }[]
}

const cssDataProvider = getDefaultCSSDataProvider()
const cssProperties = new Map(cssDataProvider.provideProperties().map((property) => [property.name, property]))
const cssPseudoClasses = new Map(cssDataProvider.providePseudoClasses().map((pseudoClass) => [pseudoClass.name, pseudoClass]))
const cssPseudoElements = new Map(cssDataProvider.providePseudoElements().map((pseudoElement) => [pseudoElement.name, pseudoElement]))

export function getMappedCssHover(
  cssLanguageService: LanguageService,
  cursorOffset: number,
  template: Template,
  virtualCss: VirtualCssDocument,
): MappedCssHover | undefined {
  const cursorInBody = cursorOffset - template.bodyStart
  const virtualOffset = virtualCss.prefixLength + cursorInBody

  if (cursorInBody < 0 || cursorInBody > virtualCss.sourceLength) {
    return undefined
  }

  const stylesheet = cssLanguageService.parseStylesheet(virtualCss.document)
  const cssHover = cssLanguageService.doHover(
    virtualCss.document,
    virtualCss.document.positionAt(virtualOffset),
    stylesheet,
  )
  const pseudoHover = getPseudoHover(template, cursorInBody, cssHover)

  if (pseudoHover) {
    return pseudoHover
  }

  const valueHover = getValueHover(template, cursorInBody)

  if (valueHover) {
    return valueHover
  }

  if (!cssHover?.range) {
    return undefined
  }

  const range = toSourceRange(cssHover.range, virtualCss)

  return range ? { contents: cssHover.contents, range } : undefined
}

function getPseudoHover(
  template: Template,
  cursorInBody: number,
  cssHover: CssHover | null,
): MappedCssHover | undefined {
  if (!isSelectorHover(cssHover)) {
    return undefined
  }

  const pseudoMatch = findPseudoAtOffset(template.maskedBody, cursorInBody)

  if (!pseudoMatch) {
    return undefined
  }

  const data = pseudoMatch.text.startsWith('::')
    ? cssPseudoElements.get(pseudoMatch.text)
    : cssPseudoClasses.get(pseudoMatch.text)
  const contents = data && toCssDataContents(data)

  if (!contents) {
    return undefined
  }

  return {
    contents,
    range: {
      start: template.bodyStart + pseudoMatch.start,
      end: template.bodyStart + pseudoMatch.end,
    },
  }
}

function getValueHover(template: Template, cursorInBody: number): MappedCssHover | undefined {
  const property = getDeclarationProperty(template.maskedBody, cursorInBody)

  if (!property) {
    return undefined
  }

  const valueToken = getValueTokenAtOffset(template.maskedBody, cursorInBody)

  if (!valueToken) {
    return undefined
  }

  const data = findValueData(property, valueToken.text, valueToken.isFunction)
  const contents = data && toCssDataContents(data)

  if (!contents) {
    return undefined
  }

  return {
    contents,
    range: {
      start: template.bodyStart + valueToken.start,
      end: template.bodyStart + valueToken.end,
    },
  }
}

function getDeclarationProperty(body: string, cursorInBody: number): IPropertyData | undefined {
  const delimiterOffset = Math.max(
    body.lastIndexOf(';', cursorInBody),
    body.lastIndexOf('{', cursorInBody),
    body.lastIndexOf('}', cursorInBody),
  )
  const declarationStart = delimiterOffset + 1
  const declaration = body.slice(declarationStart)
  const propertyMatch = /^\s*([\w-]+)\s*:/.exec(declaration)

  if (!propertyMatch) {
    return undefined
  }

  const colonOffset = declarationStart + propertyMatch[0].lastIndexOf(':')

  if (cursorInBody <= colonOffset) {
    return undefined
  }

  return cssProperties.get(propertyMatch[1])
}

function getValueTokenAtOffset(body: string, cursorInBody: number): {
  end: number
  isFunction: boolean
  start: number
  text: string
} | undefined {
  let start = Math.min(cursorInBody, body.length)
  let end = Math.min(cursorInBody, body.length)

  while (start > 0 && isCssIdentifierCharacter(body[start - 1])) {
    start -= 1
  }

  while (end < body.length && isCssIdentifierCharacter(body[end])) {
    end += 1
  }

  if (start === end) {
    return undefined
  }

  return {
    end,
    isFunction: body[end] === '(',
    start,
    text: body.slice(start, end),
  }
}

function findValueData(property: IPropertyData, token: string, isFunction: boolean): IValueData | undefined {
  const functionName = isFunction ? `${token}()` : undefined

  return property.values?.find((value) => value.name === token
    || (functionName !== undefined && value.name.replace(/\(.*/, '()') === functionName))
}

function findPseudoAtOffset(body: string, cursorInBody: number): { end: number; start: number; text: string } | undefined {
  const pattern = /:{1,2}[-\w]+/g

  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    const start = match.index
    const end = start + match[0].length

    if (cursorInBody >= start && cursorInBody <= end) {
      return { end, start, text: match[0] }
    }
  }

  return undefined
}

function isSelectorHover(hover: CssHover | null): boolean {
  return Array.isArray(hover?.contents)
    && hover.contents.some((content) => typeof content === 'string' && content.includes('Selector Specificity'))
}

function isCssIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[-\w]/.test(character)
}

function toCssDataContents(entry: CssDataEntry): CssHover['contents'] | undefined {
  if (!entry.description) {
    return undefined
  }

  const description = typeof entry.description === 'string'
    ? entry.description
    : entry.description.value
  const references = entry.references ?? []
  const referenceMarkdown = references
    .map((reference) => `[${reference.name}](${reference.url})`)
    .join('\n\n')

  return {
    kind: 'markdown',
    value: referenceMarkdown ? `${description}\n\n${referenceMarkdown}` : description,
  }
}

function toSourceRange(range: CssRange, virtualCss: VirtualCssDocument): OffsetRange | undefined {
  return mapVirtualRangeToSourceOffsets(
    virtualCss.document.offsetAt(range.start),
    virtualCss.document.offsetAt(range.end),
    virtualCss.prefixLength,
    virtualCss.sourceStart,
    virtualCss.sourceLength,
  )
}
