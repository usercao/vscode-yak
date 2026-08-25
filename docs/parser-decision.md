# yak Parser and Bundle Decision

> Decision date: 2026-08-24
>
> Scope: static yak import binding detection and tagged-template location.

## Decision

Keep the TypeScript compiler API for semantic binding recognition. Add a document-version cache around the existing TypeScript analysis rather than replacing the parser with Oxc now.

The cache stores the parsed `SourceFile` and the yak tagged templates whose import bindings have already been resolved. It is keyed by document URI and reused only while all of these values match:

- document version;
- language ID;
- file name;
- complete source text.

The completion provider invalidates that entry on VS Code document change and close events. This preserves current behavior for direct imports, aliases, namespaces, type-only imports, local shadowing, static element access, wrappers, malformed source, and nested templates without repeatedly creating a TypeScript `Program` during continuous completion requests.

## Measured Baseline

The following values were measured from a clean `yarn build` on 2026-08-24:

| Artifact | Raw size | gzip size |
| --- | ---: | ---: |
| `dist/extension.cjs` | 9,298,585 bytes (8.87 MiB) | 1,668,635 bytes (1.59 MiB) |
| `typescript/lib/typescript.js` | 9,156,263 bytes (8.73 MiB) | 1,653,821 bytes (1.58 MiB) |

The TypeScript compiler API is bundled deliberately because the published extension must be self-contained; the VS Code Extension Host does not expose a supported runtime `typescript` module for extensions to require. The parser cache targets repeated-request latency and allocation pressure, not bundle size.

### Current Budget

- Accept the current extension bundle while the semantic TypeScript API is required.
- Treat 10 MiB raw extension code and 2 MiB gzip as the current maximum budget for this feature set.
- Reassess before a change increases `dist/extension.cjs` by more than 10%, exceeds either budget, or adds another platform-specific runtime binary.
- Track the packaged VSIX separately because ZIP compression and bundled assets make it a different measurement.

## Oxc Evaluation

`oxc-parser` 0.147.0 is a high-quality and fast parser for JavaScript, JSX, TypeScript, and TSX. Its public Node API returns a TS-ESTree-compatible AST, static import records, ranges, and parser diagnostics. This is promising for a future parser-only implementation.

It is **not currently a drop-in replacement** for this extension:

1. Current correctness depends on resolving the identifier used by a tag back to a specific `yak` import symbol. That rejects shadowed function parameters and local bindings.
2. Oxc's published `ParseResult` exposes AST, static import/export information, comments, and errors, but no queryable scope graph or symbol table. Its `showSemanticErrors` option performs internal semantic checking without exposing those bindings.
3. Replacing TypeScript today would therefore require this extension to implement and maintain a JavaScript/TypeScript lexical scope binder for every supported syntax form. That would expand correctness risk rather than preserve it.
4. Oxc's Node package uses platform-specific N-API bindings. At the evaluated version, the macOS ARM64 binding is 1,810,416 bytes unpacked and the portable WASI binding is 2,033,050 bytes unpacked, including a 1,498,153-byte WASM binary. Adding that runtime requires platform packaging or a WASI fallback, explicit activation/error handling, and multi-platform test coverage.

Oxc's parser performance claims are relevant, but those parser-only benchmarks do not establish an end-to-end win once AST deserialization, custom scope binding, native/WASI loading, and Extension Host packaging are included.

### Related Oxc Packages Checked

- `oxc-resolver` resolves a module specifier to a file path. It can help a future cross-file import implementation, but it does not inspect local identifiers or lexical scopes and cannot tell whether `styled` is shadowed.
- `oxc-transform` provides syntax transforms and isolated declaration generation. It does not expose a reusable semantic binding or scope API.
- `@oxc-project/types` provides AST node types only. It distinguishes binding identifiers from identifier references structurally, but it does not connect a reference to its declaration.

None of these packages is a complete replacement for the TypeScript `TypeChecker` used by the current single-file semantic recognizer.

## Revisit Criteria

Prototype an Oxc replacement only when all of the following are true:

- a stable Node API exposes lexical scopes/symbol bindings, or a narrowly scoped local binder has a complete semantic parity test suite;
- the prototype preserves every existing binding and malformed-source regression;
- it supports the extension's macOS, Linux, and Windows targets without increasing the packaged VSIX size;
- it reduces end-to-end continuous-completion latency and lowers `dist/extension.cjs` by at least 50%;
- Extension Host tests cover the native and/or WASI runtime path on each supported platform.

Until then, cache the TypeScript analysis and keep the existing semantic resolver as the lower-risk performance path.

## Sources

- [Oxc Parser documentation](https://oxc.rs/docs/guide/usage/parser.html)
- [Oxc Parser npm package](https://www.npmjs.com/package/oxc-parser)
- [Oxc Parser Node API declarations](https://github.com/oxc-project/oxc/blob/main/napi/parser/src-js/index.d.ts)
- [Oxc Resolver npm package](https://www.npmjs.com/package/oxc-resolver)
- [Oxc Transform npm package](https://www.npmjs.com/package/oxc-transform)
