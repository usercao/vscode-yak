# next-yak VS Code 补全 MVP

## 目标

为 TypeScript 和 TSX 中的标准 next-yak tagged template 提供 CSS 属性和值补全。第一版只解决当前编辑器中的单文件、静态 CSS 区域；不实现 AST 导入解析、hover、诊断、工作区索引或自动化测试。

## 实现

运行时入口位于 `packages/next-yak-vscode/src/extension.ts`。扩展在 TypeScript 与 TSX 文档激活后注册一个 `CompletionItemProvider`，支持下列静态标签形式：

```tsx
styled.div`...`
styled(Component)`...`
css`...`
globalStyle`...`
keyframes`...`
```

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
  wid
}
```

包装层使 CSS Language Service 能将 `wid` 识别为声明位置，从而返回 `width`、`will-change` 等 CSS 属性。`keyframes` 模板改为包装在一个临时 `@keyframes` 规则中。

## 插值处理

`${...}` 内不应由 CSS 补全接管。实现会扫描模板插值，保留插值原有长度和换行、将其他字符替换为空格；这样虚拟 CSS 文档的静态区域与宿主模板保持 offset 对齐。

如果光标位于插值范围内，provider 返回 `undefined`，让 VS Code 的 TypeScript 服务提供 `props`、函数调用等原生补全。

## 范围与限制

- 依据标签文本识别，不验证 `styled`、`css` 等导入是否确实来自 `next-yak`。
- 不支持 `import { styled as s }` 或 `import * as yak` 后的 `s.div`、`yak.css`。
- `styled(Component)` 仅覆盖不含嵌套圆括号或反引号的简单调用。
- 插值扫描可处理常见的字符串、注释、对象花括号和嵌套模板，但不是完整的 TypeScript 解析器。
- 不支持 CSS 模板以外的 JavaScript/TSX 语法补全。

这些限制是最小实现有意保留的边界。后续若需要可靠导入识别或完整复杂表达式支持，应以 TypeScript AST 替换静态标签匹配。

## 构建与验证

扩展使用 `tsdown` 将 `src/extension.ts` 打为 CommonJS `dist/extension.cjs`；`vscode` 保持 external，由 VS Code 扩展宿主提供。这个选择遵循 VS Code 官方 Node 扩展 bundling 示例。当前 VS Code 也支持 ESM：当 manifest 声明 `"type": "module"` 且入口不是 `.cjs` 时，扩展宿主会使用动态 `import()`；否则会使用 CommonJS `require()`。本 MVP 选择 CJS，以符合官方示例和更广泛的既有扩展兼容路径。

`vscode-css-languageservice` 与 `vscode-languageserver-textdocument` 保持为 production dependency，由 `@vscode/vsce` 连同其依赖树写入 VSIX；因此安装后的扩展不依赖网站项目的 `node_modules`。

扩展自身使用 Yarn 4，但 VSCE 的 Yarn dependency 检测仍调用 Yarn Classic 的 `yarn list --prod --json`，会失败。因此 `package` 脚本传入 `--no-yarn`，让 VSCE 用 `npm list --omit=dev` 计算要写入 VSIX 的运行时依赖。

```bash
cd packages/next-yak-vscode
yarn check
yarn build
yarn package
```

最小手动验证：在 `styled.header` 模板内输入 `wid` 并调用补全，应出现 `width`；在 `color: ` 后调用补全，应出现颜色和 CSS 值；在 `${props => props.}` 内调用补全时，应只看到 TypeScript 的补全结果。
