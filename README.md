# vscode-yak

CSS syntax highlighting and IntelliSense for `yak` tagged templates in VS Code.

## Features

- Highlights CSS inside `styled`, `css`, `globalStyle`, and `keyframes` templates.
- Offers CSS property, value, function, at-rule, and custom property completion.
- Offers pseudo-class and pseudo-element completion for selector prefixes such as `a:` and `a::`.
- Shows CSS hover documentation for static properties, documented values/functions, pseudo-classes, and pseudo-elements, including MDN references when CSS data provides them.
- Reports safely mapped CSS syntax and lint diagnostics for static template content, including unknown properties and incomplete values.
- Offers CSS Language Service quick fixes for supported static diagnostics, such as unknown-property spelling corrections.
- Shows color decorations and picker conversions for static CSS colors, including hex, `rgb`/`rgba`, `hsl`, named colors, and gradient stops.
- Leaves `${...}` interpolations to the built-in JavaScript or TypeScript language service.
- Resolves direct, aliased, and namespace `yak` imports before providing completion.
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

Install `vscode-yak-0.1.0.vsix` using either VS Code's **Extensions: Install from VSIX...** command or the VS Code CLI:

```sh
code --install-extension ./vscode-yak-0.1.0.vsix --force
```

On macOS, when `code` is not on `PATH`, use the application-bundled CLI:

```sh
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension ./vscode-yak-0.1.0.vsix --force
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

`yarn test` runs ESM Vitest coverage for template detection, import semantics, interpolation masking, TextMate scopes, virtual-CSS mapping, CSS hover, diagnostics, and code-action safety. `yarn test:integration` starts an Extension Development Host and verifies completion, hover, diagnostics, and quick fixes in JavaScript, JSX, TypeScript, TSX, CSS props, supported yak template forms, pseudo selectors, virtual documents, cancellation, and a large-document baseline. All test source files use TypeScript; the CJS entry point required by the VS Code Extension Host is generated under `.vscode-test/compiled` immediately before integration tests run. `yarn verify` runs both test layers, the type check, and creates a standalone VSIX. CSS language-service and TypeScript parser dependencies are bundled into `dist/extension.cjs`; the packaged extension only needs the VS Code extension host's `vscode` API at runtime.

## TypeScript-First Development

**TypeScript is the default for every authored executable source file in this project, including extension code, tests, test runners, and build configuration.** Use `.ts` for new executable source unless an external runtime interface makes TypeScript infeasible or materially impractical. Any such exception must document the runtime constraint.

Generated artifacts may use CJS or ESM when a consumer requires those formats, but they are not maintained by hand. For example, [tsdown.tests.config.ts](tsdown.tests.config.ts) compiles the TypeScript Extension Host test entry into `.vscode-test/compiled/integration/extensionHost.cjs`, because VS Code loads `--extensionTestsPath` through its CommonJS-compatible test API.

The sole authored JavaScript-family fixture is [test-workspace/example.jsx](test-workspace/example.jsx). It deliberately remains JSX so the Extension Development Host can exercise the JavaScript/JSX language surface supported by this extension; it is test data rather than extension or test-runner implementation.

## Parser Performance

The extension caches TypeScript template analysis by document URI and version, invalidating it when VS Code reports a document change or close. This avoids rebuilding a TypeScript `Program` during consecutive completion requests while retaining semantic import and local-shadowing checks. [Parser and bundle decision](docs/parser-decision.md) records the measured bundle budget and the Oxc evaluation: Oxc is not currently a drop-in replacement because its public Node parser API does not expose the lexical symbol bindings needed to preserve those checks.

## Completion Reliability

The Extension Host suite enforces intentionally conservative completion latency budgets on the supported test runtime. A single-character request must finish within 1.5 seconds, a manual VS Code completion request within 2 seconds, five consecutive edits from `c` through `color` within 4 seconds, and one request in a document containing 250 tagged templates within 5 seconds. These checks run as part of `yarn test:integration` and protect against regressions rather than serving as cross-machine benchmark numbers.

The suite also covers independent completion ranges for multiple cursors, rapid document edits followed by undo and redo, and cancellation after CSS work begins. If TypeScript template analysis fails, the request returns no yak result without caching the failure, so a later request can retry. If the CSS Language Service throws or returns malformed completion data, invalid candidates are discarded and the provider returns only safely mappable results. The extension does not yet load user `css.customData` files; a corrupt injected data provider is nevertheless tested as an upstream-service failure boundary.

## Current Scope

Completion detects direct, aliased, and namespace imports from `yak` through the TypeScript AST, ignores type-only imports and locally shadowed identifiers, and supports static string element access such as `styled['div']`. Dynamic tag expressions are intentionally ignored. The TextMate grammar highlights explicit `styled`, `css`, `globalStyle`, and `keyframes` structures, including generics, `.attrs(...)`, static element access, namespaces, and CSS props. A lightweight static tag decoration makes those pattern matches easier to identify without parsing imports or replacing CSS/TypeScript token colors; aliases and actual import ownership remain AST-provider concerns. The grammar embeds standard `source.css` only and does not promise Sass, SCSS, or Less syntax.

Hover uses the same static template recognition and virtual CSS mapping as completion. It intentionally returns no hover within `${...}` interpolation, synthetic virtual CSS wrappers, unsupported keyframe step selectors, or CSS positions for which the language service has no documentation.

## CSS Diagnostics And Quick Fixes

CSS diagnostics run for the static portions of recognized yak templates. Their ranges are mapped back to the host document; diagnostics that touch `${...}` placeholders or synthetic virtual wrappers are discarded. The default `yak.css.validate` setting controls this behavior per resource without changing completion or hover.

Quick fixes are deliberately narrower. The extension currently exposes only CSS Language Service actions whose edits are wholly within one static source line of the current template. It rejects edits that touch interpolations or virtual wrappers, span multiple lines, change another document, overlap, or require a command. At present, this chiefly provides spelling suggestions for unknown CSS properties.

## CSS Colors

Color decorations and the VS Code color picker run only in the static CSS portions of recognized yak templates. Color ranges and picker edits are mapped from the virtual CSS document back to the host TypeScript, TSX, JavaScript, or JSX document. Hex, `rgb`, `rgba`, `hsl`, and named colors can be converted through the picker; an opaque exact RGB match also offers its standard CSS color name, such as `#663399` to `rebeccapurple`.

The provider rejects colors and edits that touch `${...}` interpolations, synthetic virtual wrappers, CSS comments, or quoted CSS strings. This keeps decoration and picker edits confined to source CSS that the extension can safely map.

## yak Semantic Lint

This extension owns static CSS language features inside recognized yak templates. It does not load workspace ESLint configurations or execute ESLint rules itself. Use the official `eslint-plugin-yak` with the VS Code ESLint extension for yak-specific semantic diagnostics and fixes, such as nesting-selector checks, `:global()` migration warnings, semicolon enforcement for template expressions, and runtime style-condition guidance.

For an ESLint flat config, install `eslint` and `eslint-plugin-yak` in the application workspace, then add the recommended configuration:

```ts
import yakPlugin from 'eslint-plugin-yak'
import { defineConfig } from 'eslint/config'

export default defineConfig([yakPlugin.configs.recommended])
```

The extension's CSS diagnostics and quick fixes remain limited to safely mapped static CSS. The ESLint extension owns project configuration, rule severity, suggestions, and `source.fixAll.eslint` actions.

`publisher` is currently `local` for VSIX testing. Register a Marketplace publisher and update that field before publishing to the Visual Studio Marketplace.
