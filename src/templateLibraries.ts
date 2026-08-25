export type TemplateTag = 'styled' | 'css' | 'globalStyle' | 'keyframes'

export const templateLibraryIds = ['yak', 'styled-components'] as const

export type TemplateLibraryId = (typeof templateLibraryIds)[number]

export interface TemplateLibraryProfile {
  defaultImport?: TemplateTag
  id: TemplateLibraryId
  moduleSpecifiers: readonly string[]
  namedImports: Readonly<Record<string, TemplateTag>>
  namespaceImports: Readonly<Record<string, TemplateTag>>
  staticGrammar: {
    namedTagNames: readonly string[]
    styledLikeTagNames: readonly string[]
  }
}

const yakTags = {
  css: 'css',
  globalStyle: 'globalStyle',
  keyframes: 'keyframes',
  styled: 'styled',
} as const satisfies Record<string, TemplateTag>

export const templateLibraryProfiles: readonly TemplateLibraryProfile[] = [
  {
    id: 'yak',
    moduleSpecifiers: ['next-yak', '@yak/react', '@yak/solid'],
    namedImports: yakTags,
    namespaceImports: yakTags,
    staticGrammar: {
      namedTagNames: ['css', 'globalStyle', 'keyframes'],
      styledLikeTagNames: ['styled'],
    },
  },
  {
    defaultImport: 'styled',
    id: 'styled-components',
    moduleSpecifiers: ['styled-components'],
    namedImports: {
      createGlobalStyle: 'globalStyle',
      css: 'css',
      keyframes: 'keyframes',
      styled: 'styled',
    },
    namespaceImports: {
      createGlobalStyle: 'globalStyle',
      css: 'css',
      keyframes: 'keyframes',
      styled: 'styled',
    },
    staticGrammar: {
      namedTagNames: ['createGlobalStyle', 'css', 'keyframes'],
      styledLikeTagNames: ['styled'],
    },
  },
]

export function getTemplateLibraryProfiles(
  enabledIds: readonly string[] = templateLibraryIds,
): readonly TemplateLibraryProfile[] {
  const enabledProfileIds = new Set(enabledIds)

  return templateLibraryProfiles.filter((profile) => enabledProfileIds.has(profile.id))
}

export function getTemplateLibraryProfile(
  moduleSpecifier: string,
  enabledProfiles: readonly TemplateLibraryProfile[],
): TemplateLibraryProfile | undefined {
  return enabledProfiles.find((profile) => profile.moduleSpecifiers.includes(moduleSpecifier))
}
