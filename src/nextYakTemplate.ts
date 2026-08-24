import * as ts from 'typescript'

export type NextYakTag = 'styled' | 'css' | 'globalStyle' | 'keyframes'

export interface OffsetRange {
  start: number
  end: number
}

export interface NextYakTemplate {
  bodyEnd: number
  bodyStart: number
  interpolations: readonly OffsetRange[]
  maskedBody: string
  tag: NextYakTag
}

export interface VirtualCssText {
  prefixLength: number
  text: string
}

export interface SelectorCompletionContext {
  sourceStart: number
  text: string
}

interface NamedNextYakBinding {
  kind: 'named'
  tag: NextYakTag
}

interface NamespaceNextYakBinding {
  kind: 'namespace'
}

interface TagPath {
  hasCall: boolean
  properties: string[]
  root: ts.Identifier
}

type NextYakBinding = NamedNextYakBinding | NamespaceNextYakBinding

const nextYakTagNames = new Set<NextYakTag>(['styled', 'css', 'globalStyle', 'keyframes'])

export function findNextYakTemplate(
  source: string,
  cursorOffset: number,
  languageId: string,
  fileName: string,
): NextYakTemplate | undefined {
  if (cursorOffset < 0 || cursorOffset > source.length) {
    return undefined
  }

  const scriptKind = toScriptKind(languageId)
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
  const checker = createTypeChecker(sourceFile, fileName)
  const bindings = collectNextYakBindings(sourceFile, checker)

  if (bindings.size === 0) {
    return undefined
  }

  let closestTemplate: NextYakTemplate | undefined

  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = getNextYakTag(node.tag, checker, bindings)

      if (tag) {
        const template = createTemplate(source, sourceFile, node, tag, cursorOffset)

        if (template && (!closestTemplate || template.bodyEnd - template.bodyStart < closestTemplate.bodyEnd - closestTemplate.bodyStart)) {
          closestTemplate = template
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return closestTemplate
}

export function scanTemplate(source: string, bodyStart: number, bodyEnd = source.length) {
  const interpolations: OffsetRange[] = []
  let offset = bodyStart

  while (offset < bodyEnd) {
    const character = source[offset]

    if (character === '\\') {
      offset += 2
      continue
    }

    if (character === '`') {
      return { bodyEnd: offset, interpolations }
    }

    if (character === '$' && source[offset + 1] === '{') {
      const interpolationEnd = findInterpolationEnd(source, offset + 2, bodyEnd)
      const rangeEnd = interpolationEnd ?? bodyEnd

      interpolations.push({ start: offset - bodyStart, end: rangeEnd - bodyStart })

      if (!interpolationEnd) {
        return { bodyEnd, interpolations }
      }

      offset = interpolationEnd
      continue
    }

    offset += 1
  }

  return { bodyEnd, interpolations }
}

export function isOffsetInRange(offset: number, range: OffsetRange) {
  return offset >= range.start && offset < range.end
}

export function maskInterpolations(templateBody: string, interpolations: readonly OffsetRange[]) {
  let maskedBody = ''
  let offset = 0

  for (const interpolation of interpolations) {
    maskedBody += templateBody.slice(offset, interpolation.start)
    maskedBody += templateBody.slice(interpolation.start, interpolation.end).replace(/[^\r\n]/g, ' ')
    offset = interpolation.end
  }

  return maskedBody + templateBody.slice(offset)
}

export function createVirtualCssText(template: NextYakTemplate): VirtualCssText {
  const prefix = template.tag === 'keyframes' ? '@keyframes next_yak_completion {\n' : ':root {\n'

  return {
    text: `${prefix}${template.maskedBody}\n}`,
    prefixLength: prefix.length,
  }
}

export function mapVirtualRangeToSourceOffsets(
  virtualStart: number,
  virtualEnd: number,
  prefixLength: number,
  sourceStart: number,
  sourceLength: number,
): OffsetRange | undefined {
  const start = virtualStart - prefixLength
  const end = virtualEnd - prefixLength

  if (start < 0 || end < start || end > sourceLength) {
    return undefined
  }

  return {
    start: sourceStart + start,
    end: sourceStart + end,
  }
}

export function getSelectorCompletionContext(
  source: string,
  cursorOffset: number,
  template: NextYakTemplate,
): SelectorCompletionContext | undefined {
  const lineStart = source.lastIndexOf('\n', cursorOffset - 1) + 1
  let sourceStart = Math.max(lineStart, template.bodyStart)
  let text = source.slice(sourceStart, cursorOffset)
  const indentation = text.match(/^\s*/)?.[0].length ?? 0

  sourceStart += indentation
  text = text.slice(indentation)

  if (!text || !text.includes(':') || /[;{}]/.test(text)) {
    return undefined
  }

  return { sourceStart, text }
}

function createTemplate(
  source: string,
  sourceFile: ts.SourceFile,
  taggedTemplate: ts.TaggedTemplateExpression,
  tag: NextYakTag,
  cursorOffset: number,
): NextYakTemplate | undefined {
  const templateStart = taggedTemplate.template.getStart(sourceFile)
  const bodyStart = templateStart + 1
  const hasClosingBacktick = source[taggedTemplate.template.end - 1] === '`'
  const templateEnd = hasClosingBacktick ? taggedTemplate.template.end - 1 : taggedTemplate.template.end

  if (cursorOffset < bodyStart || cursorOffset > templateEnd) {
    return undefined
  }

  const scannedTemplate = scanTemplate(source, bodyStart, templateEnd)
  const bodyEnd = scannedTemplate.bodyEnd
  const cursorInBody = cursorOffset - bodyStart

  if (scannedTemplate.interpolations.some((range) => isOffsetInRange(cursorInBody, range))) {
    return undefined
  }

  const body = source.slice(bodyStart, bodyEnd)

  return {
    bodyStart,
    bodyEnd,
    interpolations: scannedTemplate.interpolations,
    maskedBody: maskInterpolations(body, scannedTemplate.interpolations),
    tag,
  }
}

function collectNextYakBindings(sourceFile: ts.SourceFile, checker: ts.TypeChecker) {
  const bindings = new Map<ts.Symbol, NextYakBinding>()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'next-yak') {
      continue
    }

    const namedBindings = statement.importClause?.namedBindings

    if (!namedBindings) {
      continue
    }

    if (ts.isNamespaceImport(namedBindings)) {
      const symbol = checker.getSymbolAtLocation(namedBindings.name)

      if (symbol) {
        bindings.set(symbol, { kind: 'namespace' })
      }

      continue
    }

    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text

      if (!isNextYakTag(importedName)) {
        continue
      }

      const symbol = checker.getSymbolAtLocation(element.name)

      if (symbol) {
        bindings.set(symbol, { kind: 'named', tag: importedName })
      }
    }
  }

  return bindings
}

function getNextYakTag(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: ReadonlyMap<ts.Symbol, NextYakBinding>,
): NextYakTag | undefined {
  const tagPath = getTagPath(expression)

  if (!tagPath) {
    return undefined
  }

  const symbol = checker.getSymbolAtLocation(tagPath.root)
  const binding = symbol && bindings.get(symbol)

  if (!binding) {
    return undefined
  }

  if (binding.kind === 'named') {
    if (binding.tag === 'styled') {
      return tagPath.properties.length > 0 || tagPath.hasCall ? 'styled' : undefined
    }

    return tagPath.properties.length === 0 && !tagPath.hasCall ? binding.tag : undefined
  }

  const [tagName, ...remainingProperties] = tagPath.properties

  if (!isNextYakTag(tagName)) {
    return undefined
  }

  if (tagName === 'styled') {
    return remainingProperties.length > 0 || tagPath.hasCall ? 'styled' : undefined
  }

  return remainingProperties.length === 0 && !tagPath.hasCall ? tagName : undefined
}

function getTagPath(node: ts.Node): TagPath | undefined {
  if (ts.isIdentifier(node)) {
    return { root: node, properties: [], hasCall: false }
  }

  if (ts.isPropertyAccessExpression(node)) {
    const path = getTagPath(node.expression)

    if (path) {
      path.properties.push(node.name.text)
    }

    return path
  }

  if (ts.isElementAccessExpression(node)) {
    if (!node.argumentExpression || !ts.isStringLiteral(node.argumentExpression)) {
      return undefined
    }

    const path = getTagPath(node.expression)

    if (path) {
      path.properties.push(node.argumentExpression.text)
    }

    return path
  }

  if (ts.isCallExpression(node)) {
    const path = getTagPath(node.expression)

    if (path) {
      path.hasCall = true
    }

    return path
  }

  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return getTagPath(node.expression)
  }

  if (ts.isExpressionWithTypeArguments(node)) {
    return getTagPath(node.expression)
  }

  return undefined
}

function isNextYakTag(value: string): value is NextYakTag {
  return nextYakTagNames.has(value as NextYakTag)
}

function toScriptKind(languageId: string) {
  switch (languageId) {
    case 'javascript':
      return ts.ScriptKind.JS
    case 'javascriptreact':
      return ts.ScriptKind.JSX
    case 'typescript':
      return ts.ScriptKind.TS
    default:
      return ts.ScriptKind.TSX
  }
}

function createTypeChecker(sourceFile: ts.SourceFile, fileName: string) {
  const options: ts.CompilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  }
  const host = ts.createCompilerHost(options, true)

  host.fileExists = (requestedFileName) => requestedFileName === fileName
  host.getSourceFile = (requestedFileName) => requestedFileName === fileName ? sourceFile : undefined
  host.readFile = (requestedFileName) => requestedFileName === fileName ? sourceFile.text : undefined

  return ts.createProgram({ rootNames: [fileName], options, host }).getTypeChecker()
}

function findInterpolationEnd(source: string, start: number, end: number): number | undefined {
  let braceDepth = 1
  let offset = start

  while (offset < end) {
    const character = source[offset]

    if (character === "'" || character === '"') {
      offset = skipQuotedString(source, offset, character, end)
      continue
    }

    if (character === '`') {
      offset = skipTemplateLiteral(source, offset, end)
      continue
    }

    if (character === '/' && source[offset + 1] === '/') {
      offset = skipLineComment(source, offset, end)
      continue
    }

    if (character === '/' && source[offset + 1] === '*') {
      offset = skipBlockComment(source, offset, end)
      continue
    }

    if (character === '{') {
      braceDepth += 1
    } else if (character === '}') {
      braceDepth -= 1

      if (braceDepth === 0) {
        return offset + 1
      }
    }

    offset += 1
  }

  return undefined
}

function skipQuotedString(source: string, start: number, quote: string, end: number) {
  let offset = start + 1

  while (offset < end) {
    if (source[offset] === '\\') {
      offset += 2
    } else if (source[offset] === quote) {
      return offset + 1
    } else {
      offset += 1
    }
  }

  return end
}

function skipTemplateLiteral(source: string, start: number, end: number) {
  let offset = start + 1

  while (offset < end) {
    if (source[offset] === '\\') {
      offset += 2
    } else if (source[offset] === '`') {
      return offset + 1
    } else if (source[offset] === '$' && source[offset + 1] === '{') {
      offset = findInterpolationEnd(source, offset + 2, end) ?? end
    } else {
      offset += 1
    }
  }

  return end
}

function skipLineComment(source: string, start: number, end: number) {
  const lineEnd = source.indexOf('\n', start + 2)
  return lineEnd === -1 || lineEnd >= end ? end : lineEnd + 1
}

function skipBlockComment(source: string, start: number, end: number) {
  const commentEnd = source.indexOf('*/', start + 2)
  return commentEnd === -1 || commentEnd >= end ? end : commentEnd + 2
}
