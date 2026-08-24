# next-yak VS Code 补全 MVP

## 目标

为 TypeScript、TSX、JavaScript 和 JSX 中的 next-yak tagged template 提供 CSS 属性和值补全。当前版本覆盖单文件中的静态 CSS 区域、TypeScript AST 导入识别与自动化测试；暂不实现 hover、诊断或工作区索引。

## 实现

运行时入口位于 [`src/extension.ts`](../src/extension.ts)。模板定位、插值扫描和虚拟 CSS 映射位于 [`src/nextYakTemplate.ts`](../src/nextYakTemplate.ts)。扩展在 TypeScript、TSX、JavaScript 与 JSX 文档激活后注册一个 `CompletionItemProvider`，并通过 TypeScript AST 确认 tag 的绑定来自 `next-yak`。

支持下列形式：

```tsx
styled.div`...`
styled(Component)`...`
css`...`
globalStyle`...`
keyframes`...`
s.div`...`
yak.css`...`
styled.div.attrs({})`...`
```

其中 `s` 可以是 `styled` 的具名别名，`yak` 可以是 `import * as yak from 'next-yak'` 的命名空间绑定。局部同名参数或变量不会触发 next-yak CSS 补全。

补全流程如下：

```mermaid
flowchart TD
  request[TS / TSX 中请求补全] --> locate[定位标准 next-yak 模板]
  locate --> template{光标位于模板静态 CSS？}
  template -- 否 --> fallback[返回 undefined]
  template -- 是 --> mask[将 ${...} 替换为等长空白]
  mask --> virtual[包装为虚拟 CSS 文档]
  virtual --> cssls[vscode-css-languageservice]
  cssls --> map[映射 CSS 编辑范围回宿主文档]
  map --> result[返回 VS Code 补全项]
```

普通样式模板包装为：

```css
:root {
  column-fill: bal
}
```

包装层使 CSS Language Service 能识别静态 CSS 值位置，从而在 `column-fill: bal` 处返回 `balance`。`keyframes` 模板改为包装在一个临时 `@keyframes` 规则中。

根级模板中的 `a:`、`a::` 在 `:root { ... }` 包装内会被 CSS Language Service 误判为不完整的 CSS 声明。provider 会针对这种选择器上下文额外查询一个短 CSS 文档，因此仍能建议 `:hover`、`:focus`、`::before` 等伪类和伪元素；已知 CSS 属性与自定义属性不会走该回退。

## 插值处理

`${...}` 内不应由 CSS 补全接管。实现会扫描模板插值，保留插值原有长度和换行、将其他字符替换为空格；这样虚拟 CSS 文档的静态区域与宿主模板保持 offset 对齐。

如果光标位于插值范围内，provider 返回 `undefined`，让 VS Code 的 TypeScript 服务提供 `props`、函数调用等原生补全。

## 范围与限制

- 补全依据 TypeScript AST 的 import binding 识别 `next-yak`，支持具名别名和命名空间导入，并排除局部遮蔽。
- 支持 `styled(Component)`、类型参数和 `.attrs(...)` 等链式 styled 形式；TextMate 高亮 grammar 仍只能按静态文本识别。
- 插值扫描可处理常见的字符串、注释、对象花括号和嵌套模板，但不是完整的 TypeScript 解析器。
- 不支持 CSS 模板以外的 JavaScript/TSX 语法补全。

这些限制是当前实现有意保留的边界。后续若需要跨文件符号解析或更复杂的 next-yak API 识别，应在现有 TypeScript AST 路径上扩展。

## 构建与验证

扩展使用 `tsdown` 将 `src/extension.ts` 打为 CommonJS `dist/extension.cjs`；仅 `vscode` 保持 external，由 VS Code 扩展宿主提供。CSS language service 与文本模型会内联到 bundle，使 VSIX 不依赖网站项目或安装机上的 `node_modules`。当前 VS Code 也支持 ESM：当 manifest 声明 `"type": "module"` 且入口不是 `.cjs` 时，扩展宿主会使用动态 `import()`；否则会使用 CommonJS `require()`。本 MVP 选择 CJS，以符合官方示例和更广泛的既有扩展兼容路径。

`vscode-css-languageservice` 与 `vscode-languageserver-textdocument` 在构建时打入运行入口。`@vscode/vsce` 使用 `--no-dependencies` 打包，避免 Yarn 4 的开发依赖树进入 VSIX。

扩展自身使用 Yarn 4，但 VSCE 的 Yarn dependency 检测仍调用 Yarn Classic 的 `yarn list --prod --json`，会失败。因此 `package` 脚本传入 `--no-yarn`，让 VSCE 用 `npm list --omit=dev` 计算要写入 VSIX 的运行时依赖。

```bash
yarn check
yarn test
yarn test:integration
yarn build
yarn package
```

`yarn test` 覆盖 AST 导入识别、别名、命名空间、局部遮蔽、复杂插值和位置映射。`yarn test:integration` 启动真实 Extension Development Host，覆盖 TSX 中的 `a:` -> `:hover`、`a::` -> `::before`、别名、命名空间和遮蔽场景。

最小手动验证：在 `styled.header` 模板内的 `column-fill: ` 后输入 `bal` 并调用补全，应出现 `balance`；在 `a:` 后输入或调用补全，应出现 `:hover` 等伪类；在 `a::` 后应出现 `::before` 等伪元素；在 `${props => props.}` 内调用补全时，应只看到 TypeScript 的补全结果。可按 `F5` 启动 Extension Development Host 并打开 `test-workspace/`，或安装生成的 VSIX 后在任意其他项目中验证。
