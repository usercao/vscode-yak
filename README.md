# vscode-yak

VS Code extension that provides CSS syntax highlighting, folding, IntelliSense, and project CSS navigation for `next-yak` tagged templates, with optional `styled-components` compatibility.

## Package

```sh
yarn install
yarn package
```

The VSIX package is created at `build/vscode-yak-<version>.vsix`.

`yarn generate:grammars` regenerates the static TextMate injection JSON files from the
template-library profiles. `yarn generate:grammars:check` verifies that the committed
grammar files are current; `yarn build` and `yarn package` run generation before producing
their outputs.

## Use

Drag `build/vscode-yak-<version>.vsix` into the VS Code Extensions view to install it.
