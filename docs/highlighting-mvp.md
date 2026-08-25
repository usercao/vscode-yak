# vscode-yak 高亮 MVP

## 决策

先实现代码高亮，不先实现自动补全。

高亮是当前两项能力中复杂度更低的切片：它只需要一个 declarative 的 TextMate injection grammar；自动补全则还需要 TypeScript AST 识别、插值屏蔽、虚拟 CSS 文档，以及 CSS 编辑范围回写到 TSX 的位置映射。

## 实现位置

独立扩展位于 `packages/vscode-yak`。它没有运行时代码、没有根项目依赖，也不会改动网站本身的构建、格式化或 lint 配置。

高亮部分保持为 declarative TextMate grammar；补全 MVP 新增了一个独立的扩展宿主入口。它们都不依赖网站项目的运行时代码，也不会改动网站本身的构建、格式化或 lint 配置。

扩展包包含：

- `package.json`：VS Code grammar contribution 与 VSIX 打包脚本。
- `syntaxes/typescript.injection.json`：注入 TypeScript 与 TSX 的 TextMate grammar。
- `src/extension.ts`：最小 CSS 补全 provider。
- `tsconfig.json`：扩展运行时代码的类型检查配置。
- `.vscodeignore`：限制 VSIX 的打包内容。

高亮 grammar 本身不需要编译；补全入口使用 `tsdown` 打为 CommonJS，再由 `@vscode/vsce` 打包为 VSIX。完整补全范围与限制见 [completion-mvp.md](completion-mvp.md)。

扩展包通过自己的 `.yarnrc.yml` 设置 `nodeLinker: node-modules`，因此不会使用 Yarn 4 Plug'n'Play。该选择是有意的：VSCE 会动态加载 `secretlint` 规则，而 PnP 下的 `yarn dlx` 无法解析这些动态依赖；传统 `node_modules` 布局已能成功完成 VSIX 打包。扩展包独立保留自己的 `yarn.lock`，不会加入网站的 Yarn 项目。

## MVP 支持范围

支持 TypeScript 和 TSX 中的标准 yak tagged template：

```tsx
styled.div`...`
styled(Component)`...`
css`...`
globalStyle`...`
keyframes`...`
```

模板主体嵌入 VS Code 内置的 `source.css` grammar；`${...}` 插值回退到 TypeScript expression grammar。

### 顶层声明

`source.css` 的根规则从选择器和 `{ ... }` 规则开始，不能细分 `styled.div` 模板根部常见的裸声明，例如 `color: #176b5b;`。因此 injection grammar 额外定义了行首 CSS 声明规则：属性名使用 CSS property scope，值复用 `source.css#property-values`，并且在值区域优先处理 `${...}`。嵌套选择器和 at-rule 仍交由完整的 `source.css` grammar。

## 已知边界

TextMate grammar 没有导入解析能力。因此 MVP 依据标签的静态文本触发高亮，不能确认 `styled`、`css` 等标识符实际来自 `yak`，也不支持别名或命名空间导入：

```tsx
import { styled as s } from 'yak'
import * as yak from 'yak'

s.div`...` // MVP 不支持
yak.css`...` // MVP 不支持
```

同名但非 yak 的局部 API 也可能被误识别。这是高亮 MVP 有意接受的静态 grammar 限制；后续自动补全必须通过 TypeScript AST 和导入绑定解决该问题。

`styled(Component)` 的正则仅保证识别开始处的 `styled(` 和反引号，不能解析任意复杂的调用表达式。嵌套括号、多重泛型或链式 yak API 属于后续增强范围。

## 本地打包与安装

在扩展目录执行：

```bash
yarn package
```

脚本固定使用 `@vscode/vsce@3.9.2`，并为尚未公开托管的本地 MVP 传入 `--allow-missing-repository`。发布到 Marketplace 前应替换 `publisher: local`、补充实际 `repository` 元数据，并评估许可证归属。

生成 `vscode-yak-0.0.2.vsix` 后，可通过 VS Code 的 `Extensions: Install from VSIX...` 命令安装。安装后执行 `Developer: Reload Window`，再打开当前项目的 TSX 文件验证 `styled.header` 模板中的 CSS 属性、值、选择器和注释着色。

当前机器的 `code` 命令未加入 shell `PATH`，但可使用应用内命令或绝对路径调用：

```bash
'/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' --install-extension vscode-yak-0.0.2.vsix
```

## 验证标准

最小验证目标是打开 `src/layouts/MemberTestLayout.tsx` 后，下面模板的内容获得 CSS scope，而 `${...}` 内仍保留 TypeScript scope：

```tsx
const Header = styled.header`
  color: #176b5b;
  width: ${(props) => props.width};
`
```

可使用 `Developer: Inspect Editor Tokens and Scopes` 检查 `color`、`#176b5b` 和 `${props => props.width}` 的 token scope。MVP 不要求补全、hover、诊断或自动化测试。

## 已验证

在 macOS、VS Code `1.134.0`、Node `24.19.0` 与 Yarn `4.18.0` 环境中，使用 `nodeLinker: node-modules` 执行 `yarn package` 已成功生成 `vscode-yak-0.0.2.vsix`。高亮 grammar 与补全入口位于同一个 VSIX；CSS Language Service 的 production dependencies 会随 VSIX 安装，不会依赖网站项目的 `node_modules`。

使用 VS Code 自带的 TSX 与 CSS grammar 进行 token 化验证时，`styled.header` 模板中的 `color` 获得 `support.type.property-name.css`，`#176b5b` 获得 `constant.other.color.rgb-value.hex.css`，`${props => props.width}` 中的 `props` 获得 `meta.embedded.line.ts`。这确认了 CSS 根级声明和 TypeScript 插值均由预期 grammar 处理。
