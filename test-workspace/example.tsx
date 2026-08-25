import { css, globalStyle, keyframes, styled } from 'next-yak'

const accent = 'rebeccapurple'

export const Header = styled.header`
  display: grid;
  grid-template-columns: 1fr auto;
  color: ${accent};
`

export const Link = styled.a`
  a:
  a::
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
