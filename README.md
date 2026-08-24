# next-yak

CSS syntax highlighting and IntelliSense for `next-yak` tagged templates in VS Code.

## Features

- Highlights CSS inside `styled`, `css`, `globalStyle`, and `keyframes` templates.
- Offers CSS property, value, function, at-rule, and custom property completion.
- Offers pseudo-class and pseudo-element completion for selector prefixes such as `a:` and `a::`.
- Leaves `${...}` interpolations to the built-in JavaScript or TypeScript language service.
- Resolves direct, aliased, and namespace `next-yak` imports before providing completion.
- Supports TypeScript, TSX, JavaScript, and JSX files.

Supported template forms:

```tsx
const Header = styled.header`
  display: grid;
  color: rebeccapurple;
`

const rules = css`
  @media (width >= 48rem) {
    display: flex;
  }
`

const animation = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`
```

## Test In Another Project

Build the installable extension package from this repository:

```sh
yarn install
yarn package
```

Install `next-yak-vscode-0.1.0.vsix` using either VS Code's **Extensions: Install from VSIX...** command or the VS Code CLI:

```sh
code --install-extension ./next-yak-vscode-0.1.0.vsix --force
```

On macOS, when `code` is not on `PATH`, use the application-bundled CLI:

```sh
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension ./next-yak-vscode-0.1.0.vsix --force
```

Reload VS Code, open any other project containing `.ts`, `.tsx`, `.js`, or `.jsx` files, and request completion inside a supported template. For example, type `bal` after `column-fill: ` in a `styled.div` template and invoke completion to see `balance`.

The repository also contains `test-workspace/`, an isolated fixture that can be opened as a normal workspace. Press `F5` from the extension repository to launch an Extension Development Host with that fixture already open; this route tests source changes without reinstalling a VSIX.

## Development

```sh
yarn check
yarn test
yarn test:integration
yarn build
yarn verify
```

`yarn test` runs ESM Vitest coverage for template detection, import semantics, interpolation masking, TextMate scopes, and source-to-virtual-CSS mapping. `yarn test:integration` starts an Extension Development Host and verifies completion in JavaScript, JSX, TypeScript, TSX, CSS props, supported next-yak template forms, pseudo selectors, virtual documents, cancellation, and a large-document baseline. `yarn verify` runs both test layers, the type check, and creates a standalone VSIX. CSS language-service and TypeScript parser dependencies are bundled into `dist/extension.cjs`; the packaged extension only needs the VS Code extension host's `vscode` API at runtime.

## Current Scope

Completion detects direct, aliased, and namespace imports from `next-yak` through the TypeScript AST, ignores type-only imports and locally shadowed identifiers, and supports static string element access such as `styled['div']`. Dynamic tag expressions are intentionally ignored. Syntax highlighting remains TextMate-pattern based, so a visually highlighted template is not itself proof that its binding comes from `next-yak`.

`publisher` is currently `local` for VSIX testing. Register a Marketplace publisher and update that field before publishing to the Visual Studio Marketplace.
