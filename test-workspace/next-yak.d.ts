declare module 'next-yak' {
  type StyleTag = (strings: TemplateStringsArray, ...interpolations: unknown[]) => unknown

  export const styled: Record<string, StyleTag> & ((component: unknown) => StyleTag)
  export const css: StyleTag
  export const globalStyle: StyleTag
  export const keyframes: StyleTag
}
