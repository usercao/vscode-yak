/** @jsxImportSource next-yak */

import { css, globalStyle, keyframes, styled } from 'next-yak'
import { type YakConfigOptions, withYak } from 'next-yak/withYak'

// Basic next-yak fixture coverage.
const accent = 'rebeccapurple'

export const Header = styled.header`
  display: grid;
  grid-template-columns: 1fr auto;
  color: ${accent};
`

export const Link = styled.a`
  a:hover {
    color: inherit;
  }

  a::before {
    content: '';
  }
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

// Migration guide: Static component styles.
export const StaticMigrationButton = styled.button`
  background: #bf4f74;
  color: white;
  padding: 1em 2em;
  border-radius: 4px;
  transition: all 0.2s ease-in-out;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }
`

// Migration guide: Static mixins. The semicolon after the interpolation is intentional.
export const staticMigrationMixin = css`
  color: green;
  font-size: 1rem;
`

export const StaticMixinMigrationComponent = styled.div`
  background-color: yellow;
  ${staticMigrationMixin};
`

// Migration guide: Keyframes.
export const migrationRotate = keyframes`
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
`

export const KeyframeMigrationComponent = styled.div`
  display: inline-block;
  animation: ${migrationRotate} 2s linear infinite;
  padding: 2rem 1rem;
  font-size: 2rem;
`

// Migration guide: Component references. The referenced button is local so this fixture is self-contained.
export const ComponentReferenceButton = styled.button`
  border: 1px solid currentcolor;
`

export const ComponentReferenceContainer = styled.div`
  & ${ComponentReferenceButton} {
    color: red;
    margin: 0.5em;

    &:hover {
      color: darkred;
    }
  }
`

// Migration guide: .attrs on intrinsic and wrapped components.
type InputAttrsProps = {
  size?: string
}

export const AttrsInput = styled.input.attrs((props: InputAttrsProps) => ({
  type: 'text',
  size: props.size || '1em',
}))`
  color: palevioletred;
  font-size: 1em;
  border: 2px solid palevioletred;
  border-radius: 3px;
`

export type ComponentReferenceButtonProps = {
  tabIndex?: number
}

export const WrappedAttrsButton = styled(ComponentReferenceButton).attrs<
  Partial<ComponentReferenceButtonProps>
>(() => ({
  tabIndex: 0,
}))`
  color: red;
`

// Migration guide: Type-safe replacement for the unsupported `as` prop.
type HeadingElement = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

type HtmlTagProps<T extends HeadingElement> = {
  children?: string
  id?: string
  tag: T
}

const HtmlTag = <T extends HeadingElement>({ tag: Tag, children, ...props }: HtmlTagProps<T>) => (
  <Tag {...props}>{children}</Tag>
)

export const TypeSafeTitle = styled(HtmlTag)`
  font-weight: bold;
`

export const TypeSafeTitleExample = <TypeSafeTitle tag="h1">Heading 1</TypeSafeTitle>

// Migration guide: Dynamic property values are kept as interpolation boundaries.
export const DynamicValueMigrationButton = styled.button<{ $primary: boolean }>`
  background: #bf4f74;
  color: ${(props) => (props.$primary ? 'white' : '#BF4F74')};
`

// Migration guide: Dynamic CSS properties use nested css templates.
export const DynamicCssMigrationButton = styled.button<{ $primary: boolean }>`
  background: #BF4F74;
  ${(props) =>
    props.$primary
      ? css`
          color: white;
          font-size: 1rem;
          padding: 1em 2em;
        `
      : css`
          color: #BF4F74;
          font-size: 2rem;
          padding: 2em 4em;
        `}
`

// Migration guide: Dynamic mixins stay in the same file as their consuming component.
const dynamicMigrationMixin = css<{ $primary: boolean }>`
  color: green;

  ${(props) =>
    props.$primary
      ? css`
          background: white;
        `
      : css`
          background: black;
        `}
`

export const DynamicMixinMigrationComponent = styled.div<{ $primary: boolean }>`
  background-color: yellow;
  ${dynamicMigrationMixin};
`

// The guide's "move the dynamic mixin into the component file" example, kept separately for manual testing.
const movedDynamicMigrationMixin = css<{ $primary: boolean }>`
  color: green;

  ${(props) =>
    props.$primary
      ? css`
          background: white;
        `
      : css`
          background: black;
        `}
`

export const MovedDynamicMixinMigrationComponent = styled.div<{ $primary: boolean }>`
  background-color: yellow;
  ${movedDynamicMigrationMixin};
`

// Migration guide: createGlobalStyle becomes a globalStyle statement imported by the layout.
globalStyle`
  body {
    margin: 0;
  }
`

export const GlobalStylesLayoutExample = ({ children }: { children?: string }) => (
  <html>
    <body>{children}</body>
  </html>
)

// Migration guide: External selectors with native CSS transpilation mode.
export const NativeCssExternalSelectorButton = styled.button`
  color: blue;

  .myGlobalClass {
    color: red;
  }
`

// Migration guide: Deprecated CSS Modules alternative using :global().
export const GlobalSelectorMigrationButton = styled.button`
  color: blue;

  :global(.myGlobalClass) {
    color: red;
  }
`

// Migration guide: Replace style-generating utility functions with static choices or property values.
export const allColors = {
  blue: {
    primary: 'blue',
    secondary: '#F7B801',
  },
  green: {
    primary: 'green',
    secondary: '#F7B801',
  },
  red: {
    primary: 'red',
    secondary: '#F7B801',
  },
}

export const GeneratedColorMigrationButton = styled.button<{ $color: string }>`
  color: ${(props) => props.$color};
`

// Migration guide: css prop with static and dynamic values.
export const StaticCssPropMigrationExample = () => (
  <div
    css={css`
      background: papayawhip;
      color: red;
    `}
  />
)

export const DynamicCssPropMigrationExample = ({ color }: { color: string }) => (
  <div
    css={css`
      background: papayawhip;
      color: ${() => color};
    `}
  />
)

// Migration guide: In an application, this value lives in constants.yak.ts and is imported here.
const yakFileRadius = 5
export const CIRCUMFERENCE = 2 * Math.PI * yakFileRadius

export const CalculatedValueMigrationCircle = styled.div`
  width: ${CIRCUMFERENCE}px;
  height: ${CIRCUMFERENCE}px;
  border-radius: 50%;
  border: 1px solid black;
`

// Migration guide: Increase specificity while styled-components and next-yak coexist.
const StyledComponentsButton = ComponentReferenceButton

export const StyledComponentsSpecificityButton = styled(StyledComponentsButton)`
  && {
    color: red;
  }
`

// Migration guide: Next configuration examples. They are non-template examples but remain executable here.
const fixtureNextConfig = {}

export const nativeCssTranspilationConfig = withYak(
  {
    experiments: {
      transpilationMode: 'Css',
    },
  },
  fixtureNextConfig,
)

export const debugAllFilesConfig: YakConfigOptions = {
  experiments: {
    debug: true,
  },
}

export const debugPatternConfig: YakConfigOptions = {
  experiments: {
    debug: { pattern: 'myPage' },
  },
}

export const debugCssOnlyConfig: YakConfigOptions = {
  experiments: {
    debug: { types: ['css'] },
  },
}

export const debugResolvedCssConfig: YakConfigOptions = {
  experiments: {
    debug: { pattern: 'Button', types: ['css', 'css-resolved'] },
  },
}

export const debugMigrationConfig = withYak(debugResolvedCssConfig, fixtureNextConfig)

/*
tsconfig.json alternative to the file-level pragma above:
{
  "compilerOptions": {
    "jsxImportSource": "next-yak"
  }
}

The migration guide also shows these build-time pseudo-code outputs:

const DynamicValueButton = styled.button`
  background: #bf4f74;
  color: var(--next-yak-1);
`

const DynamicCssButton = (props) => (
  <button className={props.$primary ? "next-yak-1" : "next-yak-2"}>Click me</button>
)
*/

export const TransformedDynamicValueButton = styled.button`
  background: #bf4f74;
  color: var(--next-yak-1);
`

export const TransformedDynamicCssButton = ({ $primary }: { $primary: boolean }) => (
  <button className={$primary ? 'next-yak-1' : 'next-yak-2'}>Click me</button>
)
