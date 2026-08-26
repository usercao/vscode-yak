import { analyzeProjectStyles } from './template'
import { getTemplateLibraryProfiles, type TemplateLibraryProfile } from './templateLibraries'

export type ProjectCssSourceKind = 'css-module' | 'design-token' | 'global-css' | 'yak'

export interface ProjectIndexDocument {
  fileName: string
  languageId: string
  relativePath: string
  source: string
  uri: string
}

export interface IndexedCssCustomProperty {
  end: number
  name: string
  relativePath: string
  sourceKind: ProjectCssSourceKind
  start: number
  uri: string
}

export interface IndexedCssMixin {
  end: number
  exported: boolean
  name: string
  relativePath: string
  start: number
  uri: string
}

export interface CssCustomPropertyCandidate {
  definition: IndexedCssCustomProperty
  priority: number
}

export interface CssCustomPropertyToken {
  end: number
  name: string
  start: number
}

export type CssImportResolver = (fromUri: string, specifier: string) => string | undefined

interface IndexedProjectDocument {
  cssImports: readonly string[]
  definitions: readonly IndexedCssCustomProperty[]
  mixins: readonly IndexedCssMixin[]
  references: readonly IndexedCssCustomProperty[]
}

const hostLanguageIds = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact'])
const designTokenDirectoryExpression =
  /(^|\/)(?:design-tokens?|design-system|themes?|tokens?)(?:\/|$)/i

export class ProjectCssIndex {
  private readonly documents = new Map<string, IndexedProjectDocument>()

  clear(): void {
    this.documents.clear()
  }

  deleteDocument(uri: string): void {
    this.documents.delete(uri)
  }

  getCustomPropertyCandidates(
    requestUri: string,
    resolveCssImport: CssImportResolver,
  ): readonly CssCustomPropertyCandidate[] {
    const importedCssUris = this.getImportedCssUris(requestUri, resolveCssImport)
    const candidates = new Map<string, CssCustomPropertyCandidate>()

    for (const document of this.documents.values()) {
      for (const definition of document.definitions) {
        const priority = getCustomPropertyPriority(definition, requestUri, importedCssUris)

        if (priority === undefined) {
          continue
        }

        const existing = candidates.get(definition.name)

        if (
          !existing ||
          priority < existing.priority ||
          sameLocation(definition, existing.definition)
        ) {
          candidates.set(definition.name, { definition, priority })
        }
      }
    }

    return [...candidates.values()].sort(
      (left, right) =>
        left.priority - right.priority ||
        left.definition.name.localeCompare(right.definition.name) ||
        compareLocations(left.definition, right.definition),
    )
  }

  getDefinitions(
    name: string,
    requestUri: string,
    resolveCssImport: CssImportResolver,
  ): readonly IndexedCssCustomProperty[] {
    const importedCssUris = this.getImportedCssUris(requestUri, resolveCssImport)

    return this.getAllDefinitions(name)
      .flatMap((definition) => {
        const priority = getCustomPropertyPriority(definition, requestUri, importedCssUris)
        return priority === undefined ? [] : [{ definition, priority }]
      })
      .sort(
        (left, right) =>
          left.priority - right.priority || compareLocations(left.definition, right.definition),
      )
      .map(({ definition }) => definition)
  }

  getMixins(requestUri: string): readonly IndexedCssMixin[] {
    const candidates = new Map<string, { mixin: IndexedCssMixin; priority: number }>()

    for (const document of this.documents.values()) {
      for (const mixin of document.mixins) {
        if (mixin.uri !== requestUri && !mixin.exported) {
          continue
        }

        const priority = mixin.uri === requestUri ? 0 : 1
        const existing = candidates.get(mixin.name)

        if (!existing || priority < existing.priority || sameLocation(mixin, existing.mixin)) {
          candidates.set(mixin.name, { mixin, priority })
        }
      }
    }

    return [...candidates.values()]
      .sort(
        (left, right) =>
          left.priority - right.priority ||
          left.mixin.name.localeCompare(right.mixin.name) ||
          compareLocations(left.mixin, right.mixin),
      )
      .map(({ mixin }) => mixin)
  }

  getReferences(name: string, includeDeclaration: boolean): readonly IndexedCssCustomProperty[] {
    const locations = new Map<string, IndexedCssCustomProperty>()

    for (const document of this.documents.values()) {
      if (includeDeclaration) {
        for (const definition of document.definitions) {
          if (definition.name === name) {
            locations.set(locationKey(definition), definition)
          }
        }
      }

      for (const reference of document.references) {
        if (reference.name === name) {
          locations.set(locationKey(reference), reference)
        }
      }
    }

    return [...locations.values()].sort(compareLocations)
  }

  updateDocument(
    document: ProjectIndexDocument,
    templateLibraries: readonly TemplateLibraryProfile[] = getTemplateLibraryProfiles(),
  ): void {
    const sourceKind = getProjectCssSourceKind(document)
    const definitions: IndexedCssCustomProperty[] = []
    const references: IndexedCssCustomProperty[] = []
    const mixins: IndexedCssMixin[] = []
    const cssImports =
      isHostDocument(document) || isCssDocument(document)
        ? getCssImportSpecifiers(document.source)
        : []

    if (isCssDocument(document)) {
      const occurrences = getCssCustomPropertyOccurrences(document.source, 0)
      definitions.push(...toIndexedProperties(occurrences.definitions, document, sourceKind))
      references.push(...toIndexedProperties(occurrences.references, document, sourceKind))
    } else if (isHostDocument(document)) {
      const analysis = analyzeProjectStyles(
        document.source,
        document.languageId,
        document.fileName,
        templateLibraries,
      )

      for (const template of analysis.templates) {
        const occurrences = getCssCustomPropertyOccurrences(template.maskedBody, template.bodyStart)
        definitions.push(...toIndexedProperties(occurrences.definitions, document, sourceKind))
        references.push(...toIndexedProperties(occurrences.references, document, sourceKind))
      }

      for (const mixin of analysis.mixins) {
        mixins.push({
          end: mixin.nameEnd,
          exported: mixin.exported,
          name: mixin.name,
          relativePath: document.relativePath,
          start: mixin.nameStart,
          uri: document.uri,
        })
      }
    }

    this.documents.set(document.uri, { cssImports, definitions, mixins, references })
  }

  private getAllDefinitions(name: string): IndexedCssCustomProperty[] {
    return [...this.documents.values()].flatMap((document) =>
      document.definitions.filter((definition) => definition.name === name),
    )
  }

  private getImportedCssUris(
    requestUri: string,
    resolveCssImport: CssImportResolver,
  ): ReadonlySet<string> {
    const importedUris = new Set<string>()
    const pendingUris = [requestUri]

    while (pendingUris.length > 0) {
      const uri = pendingUris.pop()

      if (!uri) {
        continue
      }

      const document = this.documents.get(uri)

      for (const specifier of document?.cssImports ?? []) {
        const importedUri = resolveCssImport(uri, specifier)

        if (!importedUri || importedUris.has(importedUri) || importedUri === requestUri) {
          continue
        }

        importedUris.add(importedUri)
        pendingUris.push(importedUri)
      }
    }

    return importedUris
  }
}

export function findCssCustomPropertyAtOffset(
  source: string,
  offset: number,
): CssCustomPropertyToken | undefined {
  if (offset < 0 || offset > source.length) {
    return undefined
  }

  let start = Math.min(offset, source.length)

  if (start === source.length && isCustomPropertyCharacter(source[start - 1])) {
    start -= 1
  }

  while (start > 0 && isCustomPropertyCharacter(source[start - 1])) {
    start -= 1
  }

  const match = /^--[-_a-zA-Z][-_a-zA-Z0-9]*/.exec(source.slice(start))

  if (!match) {
    return undefined
  }

  const end = start + match[0].length

  return offset >= start && offset <= end ? { end, name: match[0], start } : undefined
}

export function isCssTextOffsetProtected(source: string, offset: number): boolean {
  let inComment = false
  let quote: '"' | "'" | undefined

  for (let index = 0; index < Math.min(offset, source.length); index += 1) {
    const character = source[index]
    const nextCharacter = source[index + 1]

    if (inComment) {
      if (character === '*' && nextCharacter === '/') {
        inComment = false
        index += 1
      }
      continue
    }

    if (quote) {
      if (character === '\\') {
        index += 1
      } else if (character === quote) {
        quote = undefined
      }
      continue
    }

    if (character === '/' && nextCharacter === '*') {
      inComment = true
      index += 1
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
    }
  }

  return inComment || quote !== undefined
}

export function isProjectIndexablePath(relativePath: string): boolean {
  return /\.(?:css|js|jsx|ts|tsx)$/i.test(relativePath)
}

function getCssCustomPropertyOccurrences(source: string, sourceStart: number) {
  const definitions: CssCustomPropertyToken[] = []
  const references: CssCustomPropertyToken[] = []
  let inComment = false
  let quote: '"' | "'" | undefined

  for (let offset = 0; offset < source.length; offset += 1) {
    const character = source[offset]
    const nextCharacter = source[offset + 1]

    if (inComment) {
      if (character === '*' && nextCharacter === '/') {
        inComment = false
        offset += 1
      }
      continue
    }

    if (quote) {
      if (character === '\\') {
        offset += 1
      } else if (character === quote) {
        quote = undefined
      }
      continue
    }

    if (character === '/' && nextCharacter === '*') {
      inComment = true
      offset += 1
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    const reference = getVarReference(source, offset)

    if (reference) {
      references.push({
        end: sourceStart + reference.end,
        name: reference.name,
        start: sourceStart + reference.start,
      })
      offset = reference.end - 1
      continue
    }

    const property = readCustomProperty(source, offset)

    if (!property) {
      continue
    }

    let next = property.end

    while (/\s/.test(source[next] ?? '')) {
      next += 1
    }

    if (source[next] === ':') {
      definitions.push({
        end: sourceStart + property.end,
        name: property.name,
        start: sourceStart + property.start,
      })
    }

    offset = property.end - 1
  }

  return { definitions, references }
}

function getCssImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>()
  const expressions = [
    /\bimport\s+(['"])([^'"]+\.css(?:[?#][^'"]*)?)\1/g,
    /\bfrom\s+(['"])([^'"]+\.css(?:[?#][^'"]*)?)\1/g,
    /@import\s+(?:url\(\s*)?(['"])([^'"]+\.css(?:[?#][^'"]*)?)\1\s*\)?/g,
  ]

  for (const expression of expressions) {
    for (const match of source.matchAll(expression)) {
      specifiers.add(match[2])
    }
  }

  return [...specifiers]
}

function getCustomPropertyPriority(
  definition: IndexedCssCustomProperty,
  requestUri: string,
  importedCssUris: ReadonlySet<string>,
): number | undefined {
  if (definition.uri === requestUri) {
    return 0
  }

  switch (definition.sourceKind) {
    case 'css-module':
      return importedCssUris.has(definition.uri) ? 1 : undefined
    case 'design-token':
      return 2
    case 'global-css':
      return importedCssUris.has(definition.uri) ? 3 : 4
    case 'yak':
      return 5
  }
}

function getProjectCssSourceKind(document: ProjectIndexDocument): ProjectCssSourceKind {
  if (!isCssDocument(document)) {
    return 'yak'
  }

  const relativePath = document.relativePath.replace(/\\/g, '/')

  if (designTokenDirectoryExpression.test(relativePath)) {
    return 'design-token'
  }

  return relativePath.endsWith('.module.css') ? 'css-module' : 'global-css'
}

function getVarReference(source: string, offset: number): CssCustomPropertyToken | undefined {
  if (
    source.slice(offset, offset + 3).toLowerCase() !== 'var' ||
    /[-_a-zA-Z0-9]/.test(source[offset - 1] ?? '')
  ) {
    return undefined
  }

  let nameStart = offset + 3

  while (/\s/.test(source[nameStart] ?? '')) {
    nameStart += 1
  }

  if (source[nameStart] !== '(') {
    return undefined
  }

  nameStart += 1

  while (/\s/.test(source[nameStart] ?? '')) {
    nameStart += 1
  }

  return readCustomProperty(source, nameStart)
}

function isCssDocument(document: ProjectIndexDocument): boolean {
  return document.languageId === 'css' || document.relativePath.toLowerCase().endsWith('.css')
}

function isCustomPropertyCharacter(character: string | undefined): boolean {
  return character !== undefined && /[-_a-zA-Z0-9]/.test(character)
}

function isHostDocument(document: ProjectIndexDocument): boolean {
  return (
    hostLanguageIds.has(document.languageId) || /\.(?:js|jsx|ts|tsx)$/i.test(document.relativePath)
  )
}

function locationKey(location: { end: number; start: number; uri: string }): string {
  return `${location.uri}:${location.start}:${location.end}`
}

function compareLocations(
  left: { relativePath: string; start: number },
  right: { relativePath: string; start: number },
): number {
  return left.relativePath.localeCompare(right.relativePath) || left.start - right.start
}

function readCustomProperty(source: string, start: number): CssCustomPropertyToken | undefined {
  const match = /^--[-_a-zA-Z][-_a-zA-Z0-9]*/.exec(source.slice(start))

  return match ? { end: start + match[0].length, name: match[0], start } : undefined
}

function sameLocation(
  left: { end: number; start: number; uri: string },
  right: { end: number; start: number; uri: string },
): boolean {
  return left.uri === right.uri && left.start === right.start && left.end === right.end
}

function toIndexedProperties(
  properties: readonly CssCustomPropertyToken[],
  document: ProjectIndexDocument,
  sourceKind: ProjectCssSourceKind,
): IndexedCssCustomProperty[] {
  return properties.map((property) => ({
    ...property,
    relativePath: document.relativePath,
    sourceKind,
    uri: document.uri,
  }))
}
