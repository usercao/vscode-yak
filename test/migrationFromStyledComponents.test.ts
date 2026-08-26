import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { analyzeProjectStyles, findTemplate, type TemplateTag } from '../src/template'

const fixtureFileName = '/migration-from-styled-components.tsx'

interface MigratedTemplateExample {
  expectedTags: readonly TemplateTag[]
  id: string
  needle: string
  source: string
  tag: TemplateTag
}

interface SyntaxOnlyMigrationExample {
  fileName: string
  id: string
  languageId: 'javascript' | 'typescript' | 'typescriptreact'
  source: string
}

const staticMixinSource = [
  "import { css, styled } from 'next-yak'",
  'const mixin = css`',
  '  color: green;',
  '  font-size: 1rem;',
  '`;',
  '',
  'const MyComp = styled.div`',
  '  background-color: yellow;',
  '  ${mixin};',
  '`;',
].join('\n')

const dynamicMixinSource = [
  "import { css, styled } from 'next-yak'",
  'const mixin = css<{ $primary: boolean }>`',
  '  color: green;',
  '  ${(props) =>',
  '    props.$primary',
  '      ? css`',
  '          background: white;',
  '        `',
  '      : css`',
  '          background: black;',
  '        `',
  '  }',
  '`;',
  '',
  'const MyComp = styled.div<{ $primary: boolean }>`',
  '  background-color: yellow;',
  '  ${mixin};',
  '`;',
].join('\n')

const migratedTemplateExamples: readonly MigratedTemplateExample[] = [
  {
    expectedTags: ['styled'],
    id: 'static-component-styles',
    needle: 'background: #bf4f74;',
    source: [
      "import { styled } from 'next-yak'",
      'const Button = styled.button`',
      '  background: #bf4f74;',
      '  color: white;',
      '  padding: 1em 2em;',
      '  border-radius: 4px;',
      '  transition: all 0.2s ease-in-out;',
      '',
      '  &:hover {',
      '    transform: translateY(-1px);',
      '    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);',
      '  }',
      '`;',
    ].join('\n'),
    tag: 'styled',
  },
  {
    expectedTags: ['css', 'styled'],
    id: 'static-mixins',
    needle: 'background-color: yellow;',
    source: staticMixinSource,
    tag: 'styled',
  },
  {
    expectedTags: ['keyframes', 'styled'],
    id: 'keyframes',
    needle: 'transform: rotate(0deg);',
    source: [
      "import { keyframes, styled } from 'next-yak'",
      'const rotate = keyframes`',
      '  from {',
      '    transform: rotate(0deg);',
      '  }',
      '  to {',
      '    transform: rotate(360deg);',
      '  }',
      '`;',
      '',
      'const Rotate = styled.div`',
      '  display: inline-block;',
      '  animation: ${rotate} 2s linear infinite;',
      '  padding: 2rem 1rem;',
      '  font-size: 2rem;',
      '`;',
    ].join('\n'),
    tag: 'keyframes',
  },
  {
    expectedTags: ['styled'],
    id: 'component-references',
    needle: 'margin: 0.5em;',
    source: [
      "import { styled } from 'next-yak'",
      "import { Button } from './button'",
      'const Container = styled.div`',
      '  ${Button} {',
      '    color: red;',
      '    margin: 0.5em;',
      '',
      '    &:hover {',
      '      color: darkred;',
      '    }',
      '  }',
      '`;',
    ].join('\n'),
    tag: 'styled',
  },
  {
    expectedTags: ['styled'],
    id: 'intrinsic-attrs',
    needle: 'border: 2px solid palevioletred;',
    source: [
      "import { styled } from 'next-yak'",
      'const Input = styled.input.attrs((props) => ({',
      '  type: "text",',
      '  size: props.size || "1em",',
      '}))`',
      '  color: palevioletred;',
      '  font-size: 1em;',
      '  border: 2px solid palevioletred;',
      '  border-radius: 3px;',
      '`;',
    ].join('\n'),
    tag: 'styled',
  },
  {
    expectedTags: ['styled'],
    id: 'wrapped-component-attrs',
    needle: 'color: red;',
    source: [
      "import { styled } from 'next-yak'",
      "import { Button, type ButtonProps } from './button'",
      'const LocalButton = styled(Button).attrs<Partial<ButtonProps>>(() => ({',
      '  tabIndex: 0,',
      '}))`',
      '  color: red;',
      '`;',
    ].join('\n'),
    tag: 'styled',
  },
  {
    expectedTags: ['styled'],
    id: 'type-safe-as-alternative',
    needle: 'font-weight: bold;',
    source: [
      "import type * as React from 'react'",
      "import { styled } from 'next-yak'",
      'type ElementType = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";',
      '',
      'const HtmlTag = <T extends ElementType>({',
      '  tag: Tag,',
      '  ...props',
      '}: {',
      '  tag: T;',
      '  children?: React.ReactNode;',
      '} & React.JSX.IntrinsicElements[T]) => <Tag {...(props as any)} />;',
      '',
      'const Title = styled(HtmlTag)`',
      '  font-weight: bold;',
      '`;',
      '',
      '<Title tag="h1">Heading 1</Title>;',
    ].join('\n'),
    tag: 'styled',
  },
  {
    expectedTags: ['styled'],
    id: 'dynamic-property-values',
    needle: 'background: #bf4f74;',
    source: [
      "import { styled } from 'next-yak'",
      'const Button = styled.button<{ $primary: boolean }>`',
      '  background: #bf4f74;',
      '  color: ${(props) => (props.$primary ? "white" : "#BF4F74")};',
      '`;',
    ].join('\n'),
    tag: 'styled',
  },
  {
    expectedTags: ['css', 'css', 'styled'],
    id: 'dynamic-css-properties',
    needle: 'background: #BF4F74;',
    source: [
      "import { css, styled } from 'next-yak'",
      'const Button = styled.button<{ $primary: boolean }>`',
      '  background: #BF4F74;',
      '  ${props => props.$primary',
      '    ? css`',
      '        color: white;',
      '        font-size: 1rem;',
      '        padding: 1em 2em;',
      '      `',
      '    : css`',
      '        color: #BF4F74;',
      '        font-size: 2rem;',
      '        padding: 2em 4em;',
      '      `',
      '  }',
      '`;',
    ].join('\n'),
    tag: 'styled',
  },
  {
    expectedTags: ['css', 'css', 'css', 'styled'],
    id: 'dynamic-mixins',
    needle: 'background-color: yellow;',
    source: dynamicMixinSource,
    tag: 'styled',
  },
  {
    expectedTags: ['globalStyle'],
    id: 'global-styles',
    needle: 'margin: 0;',
    source: [
      "import { globalStyle } from 'next-yak'",
      'globalStyle`',
      '  body {',
      '    margin: 0;',
      '  }',
      '`;',
    ].join('\n'),
    tag: 'globalStyle',
  },
  {
    expectedTags: ['styled'],
    id: 'external-styles-native-css-mode',
    needle: 'color: blue;',
    source: [
      "import { styled } from 'next-yak'",
      'const Button = styled.button`',
      '  color: blue;',
      '',
      '  .myGlobalClass {',
      '    color: red;',
      '  }',
      '`;',
    ].join('\n'),
    tag: 'styled',
  },
  {
    expectedTags: ['css', 'css', 'css', 'styled'],
    id: 'dynamic-mixins-moved-into-component-file',
    needle: 'background-color: yellow;',
    source: dynamicMixinSource,
    tag: 'styled',
  },
  {
    expectedTags: ['styled'],
    id: 'external-styles-global-selector',
    needle: ':global(.myGlobalClass)',
    source: [
      "import { styled } from 'next-yak'",
      'const Button = styled.button`',
      '  color: blue;',
      '',
      '  :global(.myGlobalClass) {',
      '    color: red;',
      '  }',
      '`;',
    ].join('\n'),
    tag: 'styled',
  },
  {
    expectedTags: ['styled'],
    id: 'style-generating-function-replacement',
    needle: '  color:',
    source: [
      "import { styled } from 'next-yak'",
      'const Button = styled.button<{ $color: string }>`',
      '  color: ${(props) => props.$color};',
      '`;',
    ].join('\n'),
    tag: 'styled',
  },
  {
    expectedTags: ['css'],
    id: 'static-css-prop',
    needle: 'background: papayawhip;',
    source: [
      "import { css } from 'next-yak'",
      'const MyComponent = () => {',
      '  return (',
      '    <div',
      '      css={css`',
      '        background: papayawhip;',
      '        color: red;',
      '      `}',
      '    />',
      '  );',
      '};',
    ].join('\n'),
    tag: 'css',
  },
  {
    expectedTags: ['css'],
    id: 'dynamic-css-prop-value',
    needle: 'background: papayawhip;',
    source: [
      "import { css } from 'next-yak'",
      'const MyComponent = ({ color }: { color: string }) => {',
      '  return (',
      '    <div',
      '      css={css`',
      '        background: papayawhip;',
      '        color: ${() => color};',
      '      `}',
      '    />',
      '  );',
      '};',
    ].join('\n'),
    tag: 'css',
  },
  {
    expectedTags: ['styled'],
    id: 'calculated-values-from-yak-file',
    needle: 'border-radius: 50%;',
    source: [
      "import { styled } from 'next-yak'",
      "import { CIRCUMFERENCE } from './constants.yak'",
      'const Circle = styled.div`',
      '  width: ${CIRCUMFERENCE}px;',
      '  height: ${CIRCUMFERENCE}px;',
      '  border-radius: 50%;',
      '  border: 1px solid black;',
      '`;',
    ].join('\n'),
    tag: 'styled',
  },
  {
    expectedTags: ['styled'],
    id: 'styled-components-specificity',
    needle: 'color: red;',
    source: [
      "import { styled } from 'next-yak'",
      'const Button = styled(StyledComponentsButton)`',
      '  && {',
      '    color: red;',
      '  }',
      '`;',
    ].join('\n'),
    tag: 'styled',
  },
]

const syntaxOnlyMigrationExamples: readonly SyntaxOnlyMigrationExample[] = [
  {
    fileName: '/layout.tsx',
    id: 'global-styles-layout-import',
    languageId: 'typescriptreact',
    source: [
      'import "./globals";',
      '',
      'export default function Layout({ children }) {',
      '  return (',
      '    <html>',
      '      <body>{children}</body>',
      '    </html>',
      '  );',
      '}',
    ].join('\n'),
  },
  {
    fileName: '/next.config.js',
    id: 'native-css-transpilation-config',
    languageId: 'javascript',
    source: [
      'export default withYak(',
      '  {',
      '    experiments: {',
      '      transpilationMode: "Css",',
      '    },',
      '  },',
      '  nextConfig,',
      ');',
    ].join('\n'),
  },
  {
    fileName: '/util.ts',
    id: 'static-style-options',
    languageId: 'typescript',
    source: [
      'export const allColors = {',
      '  red: {',
      '    primary: "red",',
      '    secondary: "#F7B801",',
      '  },',
      '  blue: {',
      '    primary: "blue",',
      '    secondary: "#F7B801",',
      '  },',
      '  green: {',
      '    primary: "green",',
      '    secondary: "#F7B801",',
      '  },',
      '};',
    ].join('\n'),
  },
  {
    fileName: '/component.tsx',
    id: 'css-prop-file-pragma',
    languageId: 'typescriptreact',
    source: '/** @jsxImportSource next-yak */',
  },
  {
    fileName: '/constants.yak.ts',
    id: 'calculated-values-yak-file',
    languageId: 'typescript',
    source: ['const RADIUS = 5;', 'export const CIRCUMFERENCE = 2 * Math.PI * RADIUS;'].join('\n'),
  },
  {
    fileName: '/next.config.ts',
    id: 'debug-config',
    languageId: 'typescript',
    source: [
      "import type { NextConfig } from 'next';",
      "import { withYak, type YakConfigOptions } from 'next-yak/withYak';",
      '',
      'const nextConfig: NextConfig = {};',
      'const yakConfig: YakConfigOptions = {',
      '  experiments: {',
      '    debug: { pattern: "Button", types: ["css", "css-resolved"] },',
      '  },',
      '};',
      '',
      'export default withYak(yakConfig, nextConfig);',
    ].join('\n'),
  },
]

const migrationPseudoCodeExamples: readonly SyntaxOnlyMigrationExample[] = [
  {
    fileName: '/transformed.tsx',
    id: 'dynamic-property-value-transformation',
    languageId: 'typescriptreact',
    source: [
      '// pseudo code',
      'const Button = styled.button`',
      '  background: #bf4f74;',
      '  color: var(--next-yak-1);',
      '`;',
    ].join('\n'),
  },
  {
    fileName: '/transformed.tsx',
    id: 'dynamic-css-property-transformation',
    languageId: 'typescriptreact',
    source: [
      '// pseudo code',
      'const Button = (props) => (',
      '  <button className={props.$primary ? "next-yak-1" : "next-yak-2"}>',
      '    Click me',
      '  </button>',
      ');',
    ].join('\n'),
  },
]

const cssPropTsConfig = JSON.stringify({
  compilerOptions: {
    jsxImportSource: 'next-yak',
  },
})

const legacyDynamicMixinSource = [
  "import { css } from 'styled-components'",
  'export const mixin = css<{ $primary: boolean }>`',
  '  color: green;',
  '  ${(props) =>',
  '    props.$primary',
  '      ? `background: white;`',
  '      : `background: black;`',
  '  }',
  '`;',
].join('\n')

function findExampleTemplate(source: string, needle: string) {
  const cursorOffset = source.indexOf(needle)

  if (cursorOffset === -1) {
    throw new Error(`Missing example text: ${needle}`)
  }

  const template = findTemplate(source, cursorOffset, 'typescriptreact', fixtureFileName)

  if (!template) {
    throw new Error(`Expected a template at example text: ${needle}`)
  }

  return template
}

function recognizedTags(source: string) {
  return analyzeProjectStyles(source, 'typescriptreact', fixtureFileName)
    .templates.map((template) => template.tag)
    .sort()
}

function getSyntaxDiagnostics(example: SyntaxOnlyMigrationExample) {
  const result = ts.transpileModule(example.source, {
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
    },
    fileName: example.fileName,
    reportDiagnostics: true,
  })

  return result.diagnostics ?? []
}

describe('next-yak migration from styled-components examples', () => {
  it('recognizes both sides of the documented import change', () => {
    const styledComponentsSource = [
      "import styled, { css, keyframes } from 'styled-components'",
      'const Button = styled.button`color: red;`',
      'const rules = css`display: grid;`',
      'const animation = keyframes`from { opacity: 0; }`',
    ].join('\n')
    const nextYakSource = [
      "import { css, keyframes, styled } from 'next-yak'",
      'const Button = styled.button`color: red;`',
      'const rules = css`display: grid;`',
      'const animation = keyframes`from { opacity: 0; }`',
    ].join('\n')

    expect(findExampleTemplate(styledComponentsSource, 'color: red;')).toMatchObject({
      library: 'styled-components',
      tag: 'styled',
    })
    expect(findExampleTemplate(nextYakSource, 'color: red;')).toMatchObject({
      library: 'yak',
      tag: 'styled',
    })
    expect(recognizedTags(styledComponentsSource)).toEqual(['css', 'keyframes', 'styled'])
    expect(recognizedTags(nextYakSource)).toEqual(['css', 'keyframes', 'styled'])

    const legacyGlobalStyleSource = [
      "import { createGlobalStyle } from 'styled-components'",
      'const GlobalStyle = createGlobalStyle`body { margin: 0; }`',
    ].join('\n')

    expect(findExampleTemplate(legacyGlobalStyleSource, 'margin: 0;')).toMatchObject({
      library: 'styled-components',
      tag: 'globalStyle',
    })
  })

  it.each(migratedTemplateExamples)('recognizes $id', (example) => {
    const template = findExampleTemplate(example.source, example.needle)

    expect(
      getSyntaxDiagnostics({
        fileName: fixtureFileName,
        id: example.id,
        languageId: 'typescriptreact',
        source: example.source,
      }),
    ).toEqual([])
    expect(template).toMatchObject({ library: 'yak', tag: example.tag })
    expect(template.maskedBody).toContain(example.needle)
    expect(recognizedTags(example.source)).toEqual([...example.expectedTags].sort())
  })

  it('indexes the documented static mixin but excludes the dynamic mixin', () => {
    const staticAnalysis = analyzeProjectStyles(
      staticMixinSource,
      'typescriptreact',
      fixtureFileName,
    )
    const dynamicAnalysis = analyzeProjectStyles(
      dynamicMixinSource,
      'typescriptreact',
      fixtureFileName,
    )

    expect(staticAnalysis.mixins).toMatchObject([{ exported: false, name: 'mixin' }])
    expect(dynamicAnalysis.mixins).toEqual([])

    const exportedStaticAnalysis = analyzeProjectStyles(
      staticMixinSource.replace('const mixin', 'export const mixin'),
      'typescriptreact',
      fixtureFileName,
    )

    expect(exportedStaticAnalysis.mixins).toMatchObject([{ exported: true, name: 'mixin' }])
  })

  it('masks runtime expressions while retaining surrounding static CSS', () => {
    const dynamicExamples = migratedTemplateExamples.filter((example) =>
      [
        'dynamic-property-values',
        'dynamic-css-properties',
        'dynamic-mixins',
        'style-generating-function-replacement',
        'dynamic-css-prop-value',
        'calculated-values-from-yak-file',
      ].includes(example.id),
    )

    for (const example of dynamicExamples) {
      const template = findExampleTemplate(example.source, example.needle)

      expect(template.interpolations.length).toBeGreaterThan(0)
      expect(template.maskedBody).not.toContain('${')
    }
  })

  it('recognizes the documented styled-components dynamic mixin input before migration', () => {
    expect(findExampleTemplate(legacyDynamicMixinSource, 'color: green;')).toMatchObject({
      library: 'styled-components',
      tag: 'css',
    })
    expect(recognizedTags(legacyDynamicMixinSource)).toEqual(['css'])
  })
})

describe('next-yak migration configuration examples', () => {
  it.each(syntaxOnlyMigrationExamples)(
    'keeps $id outside tagged-template CSS services',
    (example) => {
      expect(getSyntaxDiagnostics(example)).toEqual([])
      expect(
        analyzeProjectStyles(example.source, example.languageId, example.fileName).templates,
      ).toEqual([])
    },
  )

  it('parses the documented tsconfig jsxImportSource setting', () => {
    expect(JSON.parse(cssPropTsConfig)).toMatchObject({
      compilerOptions: {
        jsxImportSource: 'next-yak',
      },
    })
  })
})

describe('next-yak migration documentation pseudo-code', () => {
  it.each(migrationPseudoCodeExamples)('parses $id', (example) => {
    expect(getSyntaxDiagnostics(example)).toEqual([])
  })
})

describe('upstream unsupported forms', () => {
  it('does not create a CSS editing region for object syntax', () => {
    const source = [
      "import { styled } from 'next-yak'",
      "const ObjectSyntax = styled.div({ color: 'red' })",
    ].join('\n')

    expect(recognizedTags(source)).toEqual([])
  })

  it('recognizes a withConfig chain as a styled template without asserting next-yak runtime support', () => {
    const source = [
      "import { styled } from 'next-yak'",
      "const Button = styled.button.withConfig({ displayName: 'Button' })`",
      '  color: red;',
      '`;',
    ].join('\n')

    expect(findExampleTemplate(source, 'color: red;')).toMatchObject({
      library: 'yak',
      tag: 'styled',
    })
  })

  it('recognizes css tags in a dynamically selected css prop without asserting runtime support', () => {
    const source = [
      "import { css } from 'next-yak'",
      'const View = ({ active }: { active: boolean }) => (',
      '  <div',
      '    css={active ? css`color: white;` : css`color: black;`}',
      '  />',
      ');',
    ].join('\n')

    expect(recognizedTags(source)).toEqual(['css', 'css'])
  })
})
