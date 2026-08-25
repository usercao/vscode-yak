# vscode-yak 内嵌 CSS 扩展设计

## 背景

项目使用 `yak` 的 tagged template literal 定义样式，例如：

```tsx
const Header = styled.header`
  width: min(calc(100% - 32px), 760px);
  color: #176b5b;
`
```

模板内容在语义上是 CSS，但宿主文档仍是 TypeScript、TSX、JavaScript 或 JSX。现有的 `@styled/typescript-styled-plugin` 与 `styled-components.vscode-styled-components` 可以作为临时辅助方案，但无法可靠地、以 `yak` 为目标提供完整的语法高亮和 CSS IntelliSense。

本设计定义一个面向 `yak` 的 VS Code 扩展技术路线。

## 目标

- 在 `yak` 样式模板内提供 CSS 语法高亮。
- 在 CSS 位置提供属性、值、函数、at-rule 和自定义属性补全。
- 正确处理 `${...}` TypeScript/TSX 插值，并将其交给 TypeScript 语言服务。
- 为后续 hover、颜色装饰、诊断和代码操作保留可复用的基础设施。
- 仅影响编辑器体验，不改变 yak 的运行时、Vite 构建或 Oxfmt 格式化行为。

## 非目标

- 不自行实现 CSS 属性、值和浏览器兼容性数据库。
- 不在第一版中兼容所有 CSS-in-JS 库。
- 不依赖正则表达式判断某个 `styled` 标识符是否来自 `yak`。
- 不将 TypeScript server plugin 作为第一版的必需条件。

## 总体架构

高亮与语言功能应分开实现：

```mermaid
flowchart LR
  source[TS / TSX 文档] --> grammar[TextMate injection grammar]
  source --> parser[TypeScript AST 解析]
  parser --> virtual[虚拟 CSS 文档]
  virtual --> cssls[vscode-css-languageservice]
  cssls --> mapper[位置与编辑映射]
  mapper --> editor[补全、Hover、诊断、颜色]
```

TextMate grammar 负责让模板视觉上按 CSS 着色；扩展宿主内的 TypeScript AST 解析和虚拟 CSS 文档负责语言智能功能。二者共享模板标签的约定，但不必共用同一套解析实现。

## 支持的模板形式

第一版应识别下列 `yak` API：

```tsx
import { css, globalStyle, keyframes, styled } from 'yak'

const Panel = styled.div`...`
const CustomPanel = styled(Component)`...`
const rules = css`...`
const animation = keyframes`...`
globalStyle`...`
```

第二阶段再支持别名和命名空间导入：

```tsx
import { styled as s } from 'yak'
import * as yak from 'yak'

const Panel = s.div`...`
const rules = yak.css`...`
```

## 高亮方案：TextMate 注入 grammar

扩展通过 `contributes.grammars` 注册 injection grammar，并注入下列 scope：

- `source.ts`
- `source.tsx`
- `source.js`
- `source.jsx`

grammar 在标准模板标签中识别 CSS 内容，嵌入现成的 CSS grammar，并将 `${...}` 内部重新交给 JavaScript 或 TypeScript grammar。扩展应声明 `embeddedLanguages`，使括号匹配、注释和基础编辑器行为能够识别模板内的 CSS。

TextMate grammar 只适合静态、标准形式的标签识别。它不能可靠判断导入来源、局部变量遮蔽或别名，因此高亮层可以覆盖显式 `styled`、`css`、`globalStyle`、`keyframes` 及其泛型、`.attrs(...)`、静态 element access、namespace、CSS prop 等常见结构，但不能作为语义判定的唯一依据。扩展还会对这些静态匹配的 tag 添加低影响 decoration，帮助用户辨认 pattern-based 高亮；该 decoration 不读取 import、不改写 CSS 或 TypeScript token 前景色，也不把别名视为已确认的 yak API。

grammar 始终嵌入标准 `source.css`。它支持 yak 的现代标准 CSS nesting、媒体查询和 keyframes，但不构成 Sass、SCSS 或 Less 的编译、补全或语法支持承诺。

## 补全方案：AST 加虚拟 CSS 文档

扩展使用 `vscode.languages.registerCompletionItemProvider` 注册 TypeScript、TSX、JavaScript 和 JSX 文档的补全提供器。每次补全请求执行以下流程：

```mermaid
flowchart TD
  request[用户在 TSX 模板中请求补全] --> locate[定位光标所在 tagged template]
  locate --> isYak{标签来自 yak？}
  isYak -- 否 --> fallback[返回 undefined\n由其他语言服务处理]
  isYak -- 是 --> interpolation{光标位于 ${...}？}
  interpolation -- 是 --> typescript[返回 undefined\n由 TypeScript 提供补全]
  interpolation -- 否 --> virtual[生成虚拟 CSS 文档]
  virtual --> complete[调用 CSS Language Service]
  complete --> map[将 CSS 编辑范围映射回 TSX]
  map --> result[返回 CSS 补全项]
```

1. 用 TypeScript Compiler API 解析当前文档并定位光标所在的 tagged template。
2. 解析导入绑定，确认模板标签来自 `yak`。
3. 若光标在 `${...}` 插值内，返回 `undefined`，由 TypeScript 提供原生补全。
4. 将模板的静态文本转换为虚拟 CSS 文档。
5. 调用 `vscode-css-languageservice` 计算 CSS 补全。
6. 将返回的 `TextEdit`、说明和替换范围映射回原始 TSX 文档。

例如，以下两种光标位置应有不同的所有者：

```tsx
const Header = styled.header`
  col|
  color: |
  color: ${props => props.color|};
`
```

- 第一处由 CSS 服务建议 `color` 等属性。
- 第二处由 CSS 服务建议颜色、函数、`var()` 等值。
- 第三处由 TypeScript 服务建议 `props` 上的成员。

## 虚拟 CSS 文档与位置映射

模板中的插值不能原样送入 CSS 解析器。实现时应以等长度、保留换行的占位符替换 `${...}`，例如：

```tsx
const Panel = styled.div`
  color: ${(props) => props.color};
`
```

可以转换为概念上的虚拟文档：

```css
color: ______________________;
```

映射层必须保存以下信息：

- 原始模板文本的起始 offset。
- 每段静态 CSS 文本在原文与虚拟文档中的 offset 对应关系。
- 每个插值表达式的原始范围与虚拟占位范围。
- 光标是否落在插值内。

这样可以稳定地将 CSS Language Service 的范围、编辑和诊断映射回宿主文档，也能避免多行插值导致行列位置漂移。

## 语义识别规则

补全层不能只检查标签文本是否叫作 `styled`。它应通过 AST 和导入声明验证绑定来源：

```tsx
import { styled } from 'yak'

const A = styled.div`...` // 支持

const styled = makeCustomFactory()
const B = styled.div`...` // 不应当当作 yak
```

建议的第一版范围：

- 识别 `import { styled, css, globalStyle, keyframes } from 'yak'`。
- 支持同一文件内没有遮蔽的直接绑定。
- 忽略无法确认来源的标签。

在第二版中引入别名、命名空间导入以及 TypeScript checker，以获得更精确的符号解析。

## 建议依赖

- `vscode`：扩展宿主 API。
- `typescript`：AST、语法范围和可选的 symbol checker。
- `vscode-css-languageservice`：CSS 补全、hover、诊断与颜色能力。
- `vscode-languageserver-textdocument`：创建 CSS Language Service 所需的文本模型。
- `@vscode/test-electron`：端到端扩展测试。

可选依赖：

- `@vscode/vsce` 或 `@vscode/vsce` 的替代打包工具：发布 VSIX。
- `@vscode/textmate`：仅当扩展需要在测试中直接断言 grammar token 时使用。

## CSS 诊断与 yak 语义 lint 的边界

扩展内置的诊断和代码操作只处理经过 AST 识别、且能完整映射回宿主文档静态区间的 CSS：CSS 语法错误、标准 CSS lint 规则和 CSS Language Service 提供的安全修复（例如未知属性的拼写建议）。`DiagnosticCollection` 在打开、修改、关闭、语言模式切换和 `yak.css.validate` 配置变化时更新；该设置默认为启用，按资源生效，且不影响补全或 hover。

诊断映射拒绝插值占位、虚拟包装前缀/后缀与零长度范围。对于 CSS Language Service 将完整插值值的空白掩码误判为缺值、并把范围锚定到紧邻分号的已知情况，扩展也会过滤该 `css-propertyvalueexpected` 误报。代码操作只接受当前虚拟 CSS 文档的非重叠单行文本编辑；触及插值或包装区、跨行、跨文档、带命令或无法完整映射的 action 一律拒绝。

yak 特有语义不应由扩展内嵌 ESLint rule 实现。官方 `eslint-plugin-yak` 已提供嵌套选择器 `&`、`:global()` 弃用、模板表达式分号和 runtime style condition 等规则；用户在项目中安装并配置它后，由 VS Code ESLint 扩展显示诊断、suggestion、自动修复和 fix-on-save。这样既保留项目对规则启用状态和严重级别的控制，也不会让本扩展动态加载工作区 ESLint 配置、复制上游规则或依赖其内部模块。

若未来产品目标要求没有 ESLint 配置时也显示 yak 语义诊断，应先与上游协作导出稳定的分析 API，再评估独立集成；在此之前，扩展不以 ESLint 作为运行时依赖。

## 颜色装饰与 picker

扩展通过 `vscode.languages.registerColorProvider` 为已识别的 yak 模板注册颜色能力。每个请求复用模板缓存和虚拟 CSS 文档：`findDocumentColors` 返回的颜色范围必须完整映射到宿主模板的静态正文，随后才转换为 VS Code `ColorInformation`。因此 hex、`rgb`、`rgba`、`hsl`、命名颜色以及渐变中的静态颜色 stop 都能显示编辑器颜色装饰。

picker 表示转换首先确认请求 range 与 provider 已发现的静态颜色 range 完全一致，再调用 CSS Language Service 的 `getColorPresentations`。其 text edit 和 additional text edit 必须全部安全映射、互不重叠，且不触及插值、虚拟包装、注释或带引号的 CSS 字符串；否则整项表示拒绝。除 CSS Language Service 原生提供的 hex、`rgb`、`rgba`、`hsl` 等表示外，扩展使用直接声明并打包的 `color-name` 数据为 alpha 为 `1`、每个通道精确对应 8-bit RGB 的颜色追加标准 CSS 名称。近似颜色和半透明颜色不提供命名色转换。

## 扩展清单结构

建议的初始结构如下：

```text
vscode-yak/
  package.json
  tsconfig.json
  src/
    extension.ts
    template.ts
    virtualCssDocument.ts
    cssCompletionProvider.ts
  syntaxes/
    typescript.injection.json
  test/
    fixtures/
    suite/
```

`package.json` 的贡献点至少包含：

```json
{
  "activationEvents": [
    "onLanguage:typescript",
    "onLanguage:typescriptreact",
    "onLanguage:javascript",
    "onLanguage:javascriptreact"
  ],
  "contributes": {
    "grammars": [
      {
        "scopeName": "yak.injection",
        "path": "./syntaxes/yak.injection.json",
        "injectTo": ["source.ts", "source.tsx", "source.js", "source.jsx"]
      }
    ]
  }
}
```

实际 scope 名称应以 VS Code 内置 TypeScript grammar 的 scope 为准，并通过 grammar inspector 验证。

## 实施阶段

### 第一阶段：可用 MVP

- 注册 TextMate injection grammar，为标准模板形式嵌入 CSS grammar。
- 实现直接具名导入的 `yak` 模板定位器。
- 提供 CSS 属性和值补全。
- 正确跳过 `${...}` 内的补全请求。
- 为虚拟文档映射编写纯函数单元测试。

### 第二阶段：识别可靠性

- 支持 `styled as s` 与 `import * as yak`。
- 支持 `styled(Component)`。
- 支持多行、嵌套和复杂插值。
- 使用 TypeScript checker 排除局部遮蔽与同名非 yak API。

### 第三阶段：语言体验

- CSS hover、颜色装饰与颜色 picker 表示转换。
- CSS 语法诊断，并将诊断映射回宿主文档。
- 工作区自定义属性索引和补全。
- 面向变量、mixins 或 yak 特有约束的代码操作。

## 测试策略

优先将模板定位、插值遮蔽与位置映射实现为没有 VS Code 运行时依赖的纯函数，并覆盖：

- `styled.div`、`styled(Component)`、`css`、`globalStyle`、`keyframes`。
- 具名导入、别名导入、命名空间导入。
- 同名局部变量遮蔽。
- 单行和多行插值。
- 插值前、插值中、插值后的补全位置。
- 嵌套规则、at-rule、CSS 自定义属性和不完整 CSS。

再通过 `@vscode/test-electron` 验证：打开 TSX fixture 时，扩展能够在模板 CSS 区域返回补全，并在插值区域让 TypeScript 保持优先级。

## 与当前项目的关系

当前项目可以保留 `@styled/typescript-styled-plugin`、工作区 TypeScript SDK 配置和 `styled-components.vscode-styled-components` 推荐项，作为扩展尚未发布前的临时体验增强。

自研扩展稳定后，需要评估是否移除或禁用 `styled-components.vscode-styled-components` 的相关能力，以避免同一模板同时获得重复补全或发生 TextMate grammar 优先级冲突。`@styled/typescript-styled-plugin` 是否保留，则应根据其仍然提供的诊断价值单独判断。

## 决策

优先实现一个仅面向 `yak` 的 VS Code 扩展：用 TextMate grammar 完成高亮，用 TypeScript AST、虚拟 CSS 文档和 `vscode-css-languageservice` 完成补全。不要在第一版就引入独立 LSP 或尝试兼容所有 CSS-in-JS 框架。

只有当需要复用到 Neovim、Zed 等非 VS Code 编辑器时，再将模板解析器和虚拟 CSS 服务抽取为独立的 Language Server。
