declare namespace JSX {
  interface Element {
    readonly __fixtureJsxElement?: never
  }

  interface IntrinsicElements {
    [elementName: string]: Record<string, unknown>
  }
}

declare module 'next-yak' {
  export type StyleInterpolation<Props> =
    | CssFragment
    | TemplateReference
    | boolean
    | null
    | number
    | string
    | undefined
    | ((props: Props) => StyleInterpolation<Props>)

  export interface CssFragment {
    readonly __fixtureCssFragment?: never
  }

  export interface TemplateReference {
    readonly __fixtureTemplateReference?: never
  }

  export interface StyledComponent<Props = Record<string, unknown>> extends TemplateReference {
    (props: Props & { children?: unknown }): JSX.Element | null
  }

  export interface CssTag {
    <Props = Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...interpolations: StyleInterpolation<Props>[]
    ): CssFragment
  }

  export interface StyledTag {
    <Props = Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...interpolations: StyleInterpolation<Props>[]
    ): StyledComponent<Props>
    attrs<Attrs = Record<string, unknown>>(...attributes: unknown[]): StyledTag
  }

  export interface StyledFactory {
    <Component>(component: Component): StyledTag
    [elementName: string]: StyledTag
  }

  export const styled: StyledFactory
  export const css: CssTag
  export const globalStyle: CssTag
  export const keyframes: CssTag
}

declare module 'next-yak/jsx-runtime' {
  export const Fragment: unique symbol
  export function jsx(type: unknown, props: unknown, key?: unknown): JSX.Element
  export function jsxs(type: unknown, props: unknown, key?: unknown): JSX.Element
}

declare module 'next-yak/withYak' {
  export interface YakConfigOptions {
    experiments?: {
      debug?: boolean | { pattern?: string; types?: readonly string[] }
      transpilationMode?: string
    }
  }

  export function withYak<NextConfig>(yakConfig: YakConfigOptions, nextConfig: NextConfig): NextConfig
}
