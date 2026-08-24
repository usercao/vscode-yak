const styled = new Proxy(
  {},
  {
    get: () => (strings, ...interpolations) => ({ strings, interpolations }),
  },
)

const accent = 'rebeccapurple'

export const Header = styled.header`
  display: grid;
  color: ${accent};
  column-fill: bal
`
