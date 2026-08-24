type StyleTag = (strings: TemplateStringsArray, ...interpolations: unknown[]) => unknown

declare const styled: Record<string, StyleTag> & ((component: unknown) => StyleTag)
declare const css: StyleTag
declare const globalStyle: StyleTag
declare const keyframes: StyleTag

const accent = 'rebeccapurple'

export const Header = styled.header`
  display: grid;
  grid-template-columns: 1fr auto;
  color: ${accent};
  col
`

export const responsiveRules = css`
  @media (width >= 48rem) {
    display: flex;
  }
`

export const fadeIn = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`

globalStyle`
  :root {
    --accent: ${accent};
  }
`
