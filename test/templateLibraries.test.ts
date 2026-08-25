import { describe, expect, it } from 'vitest'

import {
  getTemplateLibraryProfile,
  getTemplateLibraryProfiles,
  templateLibraryProfiles,
} from '../src/templateLibraries'

describe('template library profiles', () => {
  it('treats next-yak as the primary yak module while preserving migration aliases', () => {
    const profiles = getTemplateLibraryProfiles(['yak'])

    for (const moduleSpecifier of ['next-yak', '@yak/react', 'yak']) {
      expect(getTemplateLibraryProfile(moduleSpecifier, profiles)?.id).toBe('yak')
    }
  })

  it('maps styled-components imports to shared template tags', () => {
    const profile = getTemplateLibraryProfile('styled-components', templateLibraryProfiles)

    expect(profile?.defaultImport).toBe('styled')
    expect(profile?.namedImports).toMatchObject({
      createGlobalStyle: 'globalStyle',
      css: 'css',
      keyframes: 'keyframes',
      styled: 'styled',
    })
    expect(profile?.namespaceImports).toMatchObject({
      createGlobalStyle: 'globalStyle',
      css: 'css',
      keyframes: 'keyframes',
      styled: 'styled',
    })
  })

  it('filters unknown and duplicate profile ids', () => {
    expect(
      getTemplateLibraryProfiles(['unknown', 'yak', 'yak']).map((profile) => profile.id),
    ).toEqual(['yak'])
  })
})
