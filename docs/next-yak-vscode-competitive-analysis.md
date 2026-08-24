# next-yak VS Code 扩展竞品对比与语法决策

> 调研日期：2026-08-24
>
> 参照对象：
> - [`styled-components/vscode-styled-components`](https://github.com/styled-components/vscode-styled-components)
> - [`styled-components/typescript-styled-plugin`](https://github.com/styled-components/typescript-styled-plugin)
>
> 本文比较的是当前仓库的实际实现，而非设计文档中的远期设想。竞品源码也以该日期拉取的默认分支为准；它们并不是 next-yak 的官方编辑器实现。

## 结论

当前扩展已完成一个可用的 MVP：在 TS、TSX、JS、JSX 的标准 next-yak tagged template 中提供 CSS 高亮、静态 CSS 补全，并把 `${...}` 内交还给 JavaScript/TypeScript。

与两个参照项目相比，主要缺口是语义识别、完整语言功能与测试，不是必须把模板语言改成 SCSS 或 Less。

- `next-yak` 官方定位是“使用 styled-components 风格 API 的标准 CSS 语法”，并明确展示原生 CSS 嵌套、媒体查询和 keyframes。
- `typescript-styled-plugin` 确实把虚拟模板按 `scss` 交给 `getSCSSLanguageService` 处理；`vscode-styled-components` 也使用带 `source.css.scss` scope 的 TextMate grammar。
- 这说明其编辑器实现借用 SCSS 解析能力来容忍 CSS-in-JS 常见的嵌套和插值，**不等于** styled-components 或 next-yak 的运行时会编译完整 Sass。
- 两个参照仓库都没有接入 `getLESSLanguageService` 或 `source.css.less`，没有证据表明它们支持 Less。
- 在 next-yak 的编译器明确支持前，本扩展应保持 CSS 为默认且唯一承诺的语言模式；不应把 `$var`、`@mixin`、`@include`、`@use` 或 Less 的 `@var`、mixin 当成受支持语法高亮或补全。

因此，当前项目的“CSS 模式”是符合 next-yak 官方契约的选择；不是因为 CSS-in-JS 天生排斥 SCSS，而是因为编辑器不能承诺上游编译器不支持的语法。

## 对比对象的角色

| 项目 | 角色 | 与本项目的关系 |
| --- | --- | --- |
| 当前 `next-yak-vscode` | 独立 VS Code 扩展 | 面向 next-yak；当前将高亮和 CSS 补全放在扩展宿主内实现。 |
| `vscode-styled-components` | VS Code 扩展外壳 | 注册 grammar、颜色 provider、少量编辑命令，并自动注册下方的 TypeScript server plugin。 |
| `typescript-styled-plugin` | TypeScript Language Service / tsserver plugin | 负责虚拟样式文档、补全、hover、诊断、代码操作和 Emmet 合并。 |

这意味着参照对象应作为一套组合来比较：仅安装其 VS Code 扩展，和只安装 TypeScript plugin，得到的能力都不完整。

## 当前实现基线

当前仓库的实际实现集中在 [`src/extension.ts`](../src/extension.ts) 与 [`package.json`](../package.json)：

- 对 TypeScript、TSX、JavaScript、JSX 注入 CSS TextMate grammar。
- 识别 `styled.tag`、简单 `styled(Component)`、`css`、`globalStyle`、`keyframes`。
- 将静态模板文本包装为虚拟 CSS 文档，使用 `vscode-css-languageservice` 提供属性、值、函数、at-rule 与自定义属性补全。
- 屏蔽 `${...}` 后保持 offset 对齐；插值位置返回 `undefined`，交由原生 TS/JS 补全处理。
- 将 CSS 候选优先排序，降低 TSX 中 Emmet JSX 候选遮挡 CSS 属性的影响。

当前限制同样是实际行为：模板通过文本模式识别，不检查导入来源；不支持别名、命名空间导入和复杂 `styled(...)` 链；没有 hover、诊断、代码操作、颜色 provider 或自动化测试。

## 功能对比

| 能力 | 当前项目 | `vscode-styled-components` + `typescript-styled-plugin` | 差距与建议 |
| --- | --- | --- | --- |
| CSS 高亮 | 已有 next-yak 专用注入 grammar。 | 有更成熟的 styled-components grammar，覆盖许多历史 template 形式。 | 保持 next-yak 专用识别；补齐 next-yak 的泛型、`.attrs`、`css` prop 等真实 API 形式。 |
| 模板识别 | 基于正则和固定 tag 名。 | TypeScript plugin 也以可配置 tag 名为中心，但可通过 tsserver 装饰器接入语言服务。 | 高优先级：使用 TypeScript AST 验证 `next-yak` 导入，支持别名与命名空间导入，并排除局部遮蔽。 |
| CSS 属性和值补全 | 已有，仅处理静态 CSS 位置。 | 有 CSS、SCSS、Emmet 候选合并，随 tsserver 提供给 TS/JS。 | 已达到 MVP；后续加入 next-yak 的模板形态和用户自定义 CSS 数据即可。 |
| Hover | 未实现。 | TypeScript plugin 调用 SCSS language service 的 hover。 | 高价值：复用已有虚拟文档与位置映射实现 CSS hover。 |
| CSS 诊断 | 未实现。 | 有语法/规则诊断，并把结果映射回 TS/JS 源文件。 | 高价值：提供 CSS 语法错误、未知属性等诊断；需要避免在 `${...}` 附近报误报。 |
| 快速修复 | 未实现。 | 支持 CSS language service code actions，例如拼写修复。 | 在诊断映射稳定后实现。 |
| 颜色功能 | 未实现。 | VS Code 扩展注册颜色 provider，支持色块与颜色表示转换。 | 中优先级：添加 `DocumentColorProvider` 与颜色表示转换。 |
| 折叠 | 依赖宿主文档默认行为。 | TypeScript plugin 能返回模板折叠范围。 | 可在用户反馈需要时补充；优先级低于诊断和 hover。 |
| 输入辅助 | 无。 | 提供展开模板的 snippet，以及接受属性后插入 `: ;` 的命令。 | 可选体验增强；不要为了模仿而破坏 VS Code 的默认 Enter 行为。 |
| 配置 | tag 名和行为目前硬编码。 | 可配置 tags、lint、Emmet 选项。 | 中优先级：提供 next-yak 标签别名和自定义 CSS 数据配置；lint 规则应先采用 CSS language service 的能力。 |
| Emmet | 受 VS Code 对整个 TSX 文档语言的限制；CSS 项已优先排序。 | 自带 Emmet helper 合并，README 也承认存在 VS Code/TypeScript 上游限制。 | 不要用全局禁用 TSX Emmet 解决局部问题；保留现有 CSS 候选优先策略。 |
| 自动化测试 | 当前没有项目测试。 | 有单元测试和端到端测试，覆盖补全、错误、快速修复、Emmet、outline；VS Code 扩展也有 grammar/颜色测试。 | 最高优先级基础工作：提取纯函数并覆盖模板定位、插值、位置映射和 VS Code 集成行为。 |
| 维护状态 | 本项目可按 next-yak 的当前版本演进。 | VS Code styled-components 仓库官方说明自 2024-06 起不再由团队维护；TypeScript plugin 默认分支的最近提交也较旧。 | 学习架构和测试策略，不应无审查地复制旧依赖、旧 grammar 或历史 API。 |

## 推荐实施顺序

### P0：识别正确性与可测试性

1. 将模板定位、插值扫描、虚拟文档创建、位置映射拆为无 VS Code 运行时依赖的纯函数。
2. 引入 TypeScript AST，确认绑定来自 `next-yak`，并支持：
   - `import { styled as s } from 'next-yak'`
   - `import * as yak from 'next-yak'`
   - `s.div`、`yak.css`、`styled(Component)` 的真实变体
   - 类型参数与 `.attrs` 等 next-yak 支持的 styled 链
3. 为上述规则和多行/嵌套插值写单元测试；再通过 `@vscode/test-electron` 覆盖 TSX 真实补全行为。

这是最重要的一步。若识别范围错误，后续 hover、诊断和快速修复都会在非 next-yak 模板中产生噪声。

### P1：补齐语言功能

1. 基于同一虚拟 CSS 文档实现 hover。
2. 通过 `doValidation` 映射 CSS 诊断，并过滤插值占位区的误报。
3. 将 CSS language service 的代码操作映射回原文，提供属性拼写等快速修复。
4. 添加颜色 provider 和颜色表示转换。

这些能力的技术基础已经在当前虚拟文档映射中存在，不需要先引入独立 Language Server 或 tsserver plugin。

### P2：扩展 next-yak 专属体验

1. 增加 `css` prop、静态 mixin、组件引用、`atoms` 插值等官方示例的 fixture。
2. 支持工作区 CSS 自定义属性索引、用户提供的 CSS custom data 和可配置附加 tag。
3. 仅在需要把语言功能嵌入 TypeScript 原生导航/诊断管线，且能接受 workspace TypeScript 配置负担时，再评估 tsserver plugin。

不建议现在重写为 TypeScript server plugin。独立 VS Code 扩展更容易随 next-yak API 发布，且不会要求用户切换到工作区 TypeScript 版本。

## CSS、SCSS 与 Less 的边界

### CSS-in-JS 不是一种 CSS 方言

“CSS-in-JS”描述的是样式写在 JS/TS 中、通常由 tagged template 或对象 API 承载，并在运行时或构建时生成 CSS 的方式。它不规定模板必须是纯 CSS、SCSS 或 Less。

因此：一个 CSS-in-JS 库可以选择支持 Sass，也仍然是 CSS-in-JS；但是否可用必须由该库的编译链明确实现和测试。

### next-yak 应承诺什么

next-yak 官方文档称其为标准 CSS 语法，并明确支持嵌套、keyframes 与媒体查询。下面的写法应作为本扩展的目标体验：

```tsx
const Button = styled.button`
  color: rebeccapurple;

  &:hover {
    color: white;
  }

  @media (width >= 48rem) {
    padding: 1rem;
  }
`
```

其中 `&:hover` 不是 Sass 独有特性：CSS Nesting 已成为标准 CSS 的一部分，也是 CSS-in-JS 与现代 CSS 中常见的写法。

截至本文调研基线，next-yak 的官方文档与 `css_in_js_parser` 源码没有声明或引入 Sass/SCSS/Less 编译器；解析器明确处理 CSS scope nesting。故下列预处理器特性不应被本扩展宣称为受 next-yak 支持：

```scss
// Sass/SCSS：不要承诺支持
$brand: rebeccapurple;
@mixin focus-ring { outline: 2px solid $brand; }
@include focus-ring;
```

```less
// Less：不要承诺支持
@brand: rebeccapurple;
.focus-ring() { outline: 2px solid @brand; }
.focus-ring();
```

这不妨碍用户使用标准 CSS 自定义属性：

```css
:root {
  --brand: rebeccapurple;
}
```

### 为什么竞品选择 SCSS language service

`typescript-styled-plugin` 会创建 `untitled://embedded.scss` 虚拟文档，并同时请求 CSS 与 SCSS completion；hover、诊断、代码操作和折叠使用 SCSS language service。其 VS Code grammar 也标为 `source.css.scss`。

这是一种编辑器实现策略：SCSS parser 对嵌套规则、`&` 选择器、插值和 CSS-in-JS 的历史写法更宽容。它不负责将模板编译成 Sass，也没有接入 Less language service。其端到端测试甚至明确验证某些属性值补全中不应返回 SCSS 函数。

因此不应从“竞品用了 SCSS parser”推导出“next-yak 应支持完整 SCSS”；更不能推导出 Less 支持。

### 未来若要支持预处理器

只有同时满足以下条件时，才应考虑加入可选 SCSS 或 Less 模式：

1. next-yak 上游明确宣布并测试对应语法的编译支持。
2. 构建产物的 CSS 处理链能可靠处理该语法，而不是只让编辑器看起来不报错。
3. 本扩展针对高亮、补全、hover、诊断、代码操作和混合 `${...}` 插值都有 fixture 与端到端测试。
4. 默认模式仍保持 `css`，避免现有 next-yak 项目因编辑器误报或错误补全而回归。

在这之前，最合适的演进是增强现代 CSS 和 next-yak 专属模板识别，而不是引入伪 SCSS/LESS 支持。

## 取证与调研基线

- 当前实现：[`src/extension.ts`](../src/extension.ts)、[`package.json`](../package.json)、[`next-yak-vscode-completion-mvp.md`](next-yak-vscode-completion-mvp.md)。
- next-yak 官方文档：[Getting started](https://yak.js.org/docs/getting-started)、[Features](https://yak.js.org/docs/features)、[Migration from styled-components](https://yak.js.org/docs/migration-from-styled-components)、[How it works](https://yak.js.org/docs/how-does-it-work)。
- next-yak 上游调研基线：`2ec61c5d89ad39a2f92fa44cb8ff64b871d31926`（2026-08-21）；其中 `css_in_js_parser` 负责 CSS scope nesting。
- styled-components VS Code 扩展：[`package.json`](https://github.com/styled-components/vscode-styled-components/blob/fe0107ead786d36411bc7609eb3cc73a76e43e60/package.json)、[`src/extension.ts`](https://github.com/styled-components/vscode-styled-components/blob/fe0107ead786d36411bc7609eb3cc73a76e43e60/src/extension.ts)、[`syntaxes/styled-components.json`](https://github.com/styled-components/vscode-styled-components/blob/fe0107ead786d36411bc7609eb3cc73a76e43e60/syntaxes/styled-components.json)。其 README 标注自 2024-06 起不再由 styled-components 团队维护。
- TypeScript styled plugin：[`src/_language-service.ts`](https://github.com/styled-components/typescript-styled-plugin/blob/a0d66c45a8c5d8b251a72e5286f1ec4d8f79337b/src/_language-service.ts)、[`src/_virtual-document-provider.ts`](https://github.com/styled-components/typescript-styled-plugin/blob/a0d66c45a8c5d8b251a72e5286f1ec4d8f79337b/src/_virtual-document-provider.ts)、[README](https://github.com/styled-components/typescript-styled-plugin/blob/a0d66c45a8c5d8b251a72e5286f1ec4d8f79337b/README.md)。
