# vscode-yak CSS 边界测试策略

> 本文收录主 TODO 中 P1「标准 CSS 语法高亮与 at-rule 补全」的详细验收项、测试矩阵和回归收录规则。总路线图见 [todo.md](todo.md)。
>
> 更新日期：2026-08-25。

## 目的

这不是一份“覆盖全部 CSS 语法”的承诺。yak 扩展将 JavaScript/TypeScript 中的 tagged template 映射为虚拟 CSS，再分别交由 TextMate grammar、CSS Language Service 和 VS Code provider 处理；因此一个用户可见问题可能发生在不同层，不能只靠不断添加同类型 TODO 解决。

本文的完成标准是：对每种已支持的用户体验，在其实际所有者处建立最小、可重复的回归用例；新发现的真实问题先归类，再变成 fixture。覆盖范围随真实使用和上游 CSS 数据演进扩大，但不会要求对所有语法维度做笛卡尔积穷举。

## 范围与非目标

- 目标范围是标准 CSS、现代 CSS nesting、媒体查询、keyframes 和由打包的 `vscode-css-languageservice` CSS data 支持的 at-rule。
- 不将 Sass、SCSS 或 Less 的 `$variable`、`@mixin`、`@include` 或 Less mixin 作为支持目标。
- TextMate grammar 是静态文本匹配，不能验证 `styled` 是否真的从 `yak` 导入；补全、hover 等语义 provider 必须继续以 TypeScript AST binding 判断为准。
- 不因缺少某个上游候选而伪造不安全的编辑。无法安全映射到宿主文档的 CSS Language Service 结果必须拒绝。
- 这里的 fixture 关注编辑器可见行为，不取代浏览器 CSS 渲染、yak 编译结果或完整 TypeScript 类型测试。

## 测试分层

| 层级 | 直接所有者 | 适合证明的内容 | 主要测试位置 |
| --- | --- | --- | --- |
| TextMate grammar | `syntaxes/typescript.injection.json`、`syntaxes/javascript.injection.json` | CSS 是否被注入、关键 token 是否拥有正确 CSS scope、宿主 JS/TSX 是否在模板后恢复 | [test/grammar.test.ts](../test/grammar.test.ts) |
| 模板与虚拟 CSS | `src/template.ts` | tagged template 定位、插值屏蔽、wrapper、光标归属和 virtual-to-source range 映射 | [test/template.test.ts](../test/template.test.ts) |
| 补全转换 | `src/extension.ts` | CSS Language Service 项目是否被过滤、候选排序、snippet 和 replacement range 是否安全 | 对应的纯函数测试；没有纯函数边界时保持实现局部 |
| Extension Host | provider 注册和真实 VS Code API | 用户会看到的候选、编辑后替换范围、跨语言、取消请求与缓存失效 | [test/integration/extensionHost.ts](../test/integration/extensionHost.ts) |

同一语法片段不需要在每层复制全部断言。例如，`from` 是否被染成 CSS keyframe step 属于 grammar；`@med` 选中 `@media` 后是否只替换 `@med` 属于 Extension Host。只有涉及插值、wrapper 或 range 时，才额外补模板层测试。

## 当前基线与完成状态

现有测试已经覆盖四种宿主语言、常见 yak tagged template、插值隔离、虚拟 range、防止 at-rule 走伪类回退、keyframes 内的属性补全、取消请求和连续请求性能。

本轮 P1 已补齐以下用户可见行为：

- `keyframes` 模板中的 `from`、`to` 获得 `entity.other.keyframe-offset.css` scope，百分比步骤获得 `entity.other.keyframe-offset.percentage.css` scope；步骤块内部继续使用内置 CSS 的属性和值规则。未闭合步骤或 `{` 在反引号处恢复宿主语法，不吞掉后续 TS/JSX。
- at-rule 名称候选由当前 `vscode-css-languageservice` CSS data 驱动，再按 tagged template 的合法位置收紧：`styled` 与 `css` 提供可嵌套的分组规则；顶层 `globalStyle` 额外提供 `@font-face`、`@property` 等 descriptor 规则。`@charset`、`@import`、`@namespace` 只能位于完整 stylesheet 的特定位置，故不在 tagged template 中建议。
- 上下文扫描区分 at-rule 名称、prelude、分组规则块、descriptor 名称和值；注释、字符串、`url()`、插值和 keyframes wrapper 会拒绝 at-rule 候选。当前 CSS Language Service 在虚拟 wrapper 的 media prelude 位置不提供可靠候选，因此该位置采用安全拒绝，不把普通 CSS 属性或伪选择器混入其中。
- `@property` descriptor 使用 CSS data 的 `atRule` 标记；`@font-face` 额外补足 CSS data 未标记但必需的 `font-family` descriptor。所有手写候选都直接以 source offset 建立 replacement range。

当前普通模板会被包装成一个临时规则，keyframes 模板会被包装成临时 `@keyframes` 规则。这使 keyframes step、at-rule 嵌套和虚拟范围映射成为高风险交界，而不是单纯的 CSS 数据问题。

## P1 专项清单

- [x] **CSS-B01: keyframe 关键字步骤高亮。** `from` 和 `to` 使用原生 CSS keyframe selector scope，且不被误标为普通元素选择器或裸声明。
- [x] **CSS-B02: keyframe 百分比步骤高亮。** `0%`、`50%`、`100%` 与逗号分隔百分比步骤使用原生 percentage scope；步骤块中的属性和值函数仍按 CSS 处理。
- [x] **CSS-B03: at-rule 名称候选。** 在静态 yak CSS 的合法名称位置输入 `@` 或前缀时，提供以 `@media` 为最低基线的候选，并以宿主 source offset 建立安全 replacement range。
- [x] **CSS-B04: at-rule 候选数据策略。** 基于当前 `vscode-css-languageservice` CSS data 及位置白名单审查并覆盖 `@media`、`@supports`、`@container`、`@layer`、`@scope`、`@keyframes`、`@font-face` 和 `@property`。
- [x] **CSS-B05: at-rule 上下文分流。** 区分名称、prelude、规则块和 descriptor block；prelude 使用安全拒绝，规则和 descriptor 块不会混入伪选择器或位置不适用的 at-rule。
- [x] **CSS-B06: 非法位置拒绝。** 属性值、注释、字符串、`url(...)`、`${...}` 插值、descriptor/keyframes wrapper 及无法完整映射的 Language Service range 中均拒绝 at-rule 补全。
- [x] **CSS-B07: 四种宿主 grammar 回归。** TypeScript、TSX、JavaScript 和 JSX 均覆盖 `from`、`to`、百分比步骤、未闭合步骤/块和模板后的宿主 scope 恢复。
- [x] **CSS-B08: provider 交互回归。** `@`、`@med`、嵌套 `@media`、`@property`、`@font-face` 均有单元和 Extension Host 测试，覆盖候选、replacement range、隔离区和取消请求。

## 最小测试矩阵

矩阵用于选择代表用例，而不是要求每一行都与所有宿主语言、tag 形态和编辑状态组合。新增案例应优先覆盖一个未覆盖的风险交界。

| 维度 | 必选代表状态 | 主要层级 | 选择原则 |
| --- | --- | --- | --- |
| 宿主语言 | `ts`、`tsx`、`js`、`jsx` | grammar | CSS 注入规则分别依赖 TS/JS grammar；四种语言均需有关键 scope 断言 |
| yak tag | 直接 `keyframes`、直接 `styled.*`、`globalStyle` | grammar / Extension Host | grammar 只验证它能静态识别的形态；provider 按 tag 的合法 at-rule 位置收紧候选 |
| 语义 tag | 具名别名、命名空间、`.attrs(...)`、`styled(Component)` | grammar + Extension Host | grammar 覆盖显式结构的 CSS scope；别名和 import ownership 继续由 AST binding 覆盖，未知别名不得被静态 grammar 猜测为 CSS |
| keyframe step | `from`、`to`、`0%`、逗号分隔的 `68%, 72%` | grammar；必要时模板层 | 同时覆盖关键字、数值和同一 selector list 中的逗号 |
| at-rule 名称 | `@`、`@med` | Extension Host | 分别验证空前缀和部分输入的候选及 edit range |
| at-rule 结构 | 根级 `@media`、嵌套 `@supports`、`@media` prelude、分组规则 body | Extension Host | 覆盖名称、prelude 安全拒绝及规则进入块后继续出现属性补全的路径 |
| descriptor | `@font-face`、`@property` | Extension Host | 证明 descriptor context 使用专属候选集，而非普通 rule 的候选集 |
| 隔离区 | 注释、字符串、`url()`、属性值、插值、未闭合结构 | 模板层和 Extension Host | 证明 provider 不抢占宿主语言服务，也不产生越界 edit |
| 编辑中间态 | 未闭合 `{`、`(`、反引号、插值，`@`、`@med`、`50%` | grammar 和 provider | 现实输入通常处于不完整状态，不能只测试格式完整的源文件 |

### 建议的最小 fixture

#### Keyframes

```tsx
const spin = keyframes`
  from { transform: rotate(0deg); }
  50%, 72% { opacity: 0.5; }
  to { transform: rotate(1turn); }
`
```

此 fixture 应拆成以下断言，而不是对整份 token 流做一张脆弱的大快照：

- `from`、`to`、`50%`、`72%` 在目标 CSS keyframe step scope 中。
- `transform` 仍是 CSS property，`rotate` 仍是 CSS function，模板关闭后宿主代码 scope 正常。
- `50`、`50%`、`from {` 等编辑中间态不应把后续宿主代码吞进 CSS scope。

#### At-rule

```tsx
const Panel = styled.div`
  @med
  @media (min-width: 48rem) {
    display: gri
  }
`
```

该 fixture 至少证明：

- 根级 `@` 和 `@med` 存在 `@media` 候选；应用候选只替换当前 at-rule 前缀。
- `@media` prelude 不暴露不可靠的 yak 候选；block 内的 `gri` 仍获得 CSS 属性候选，不退化为伪选择器候选。
- 在 `color: @`、注释、字符串、`url(@asset)` 和 `${condition}` 内没有 at-rule 候选。
- 在 `globalStyle` 的 `@font-face { font-... }` 与 `@property --size { syntax: ... }` 中验证与普通 rule 不同的 descriptor 候选上下文。

## 各层断言规则

### Grammar

- 断言关键 lexeme 是否包含预期 CSS scope，而不是断言全部 scope 字符串或主题颜色。
- 每个新增 grammar 规则同时加入一个模板结束后的 TS/JSX lexeme 断言，防止贪婪 match 破坏后续宿主高亮。
- 对四种宿主语言至少保留 keyframes 的完整 fixture 和一个不完整编辑态 fixture；没有行为差异的普通 CSS 属性无需四倍复制。
- 静态 grammar 可能会高亮非 `yak` 的同形 tagged template，这属于已知限制。该限制要以负向测试记录，不能让它阻塞 AST 语义 provider 的正确性。
- 对泛型、`.attrs(...)`、静态 element access、namespace API 和 CSS prop 等显式结构，四种宿主语言均应验证 CSS scope 与模板结束后的宿主 scope 恢复。alias 不应由 grammar 猜测；它只由 AST provider 确认。
- 扩展可以为静态 pattern match 的 tag 添加不读取 import 的低影响 decoration，帮助用户辨认其静态性质；不得以 decoration 覆盖 CSS/TypeScript 前景 token，或暗示该模板已通过语义 binding 校验。

### 模板与虚拟 CSS

- 所有从 CSS Language Service 返回的 range 必须完全位于 template 静态文本；碰到 prefix、suffix、插值或越界时返回 `undefined`。
- 新增 at-rule 上下文判断时，至少测试光标在名称、prelude、rule body、插值和 wrapper 边界的归属。
- 插值继续使用等长且保留换行的屏蔽策略；不能因为在 media condition 或 keyframe step 附近出现插值而破坏后续 offset。

### Extension Host

- 断言 `CompletionItem` 的 label 只是起点；还应断言 text edit 或 range 只覆盖用户已键入的 `@` 前缀，避免选择候选时删除周边 CSS。
- 对每种新上下文验证正向候选和至少一个最相邻的负向候选。例如 `@media` 内属性补全为正向，`@media` 名称位置出现伪类为负向。
- 保留 cancellation 测试，因为 `@` 会在每次输入时重新触发候选；被取消的请求不能返回过时 edit。
- 对 CSS Language Service 数据不足的规则只测试安全降级，不把“某版本恰好提供某候选”写成永久扩展保证。

## 从 vscode-styled-components 吸取的经验

上游仓库已归档，但它的测试演进很适合借鉴方法，而不适合直接复制 grammar 或 Sass/SCSS 规则。

| 上游经验 | 对 yak 的做法 |
| --- | --- |
| [colorization.test.js](https://github.com/styled-components/vscode-styled-components/blob/main/src/tests/suite/colorization.test.js) 自动枚举最小 fixture，并保存 token 结果 | 以每个真实问题的最小复现为 fixture；当前优先沿用确定性的关键 scope 断言，待 corpus 变大再评估轻量 golden 机制 |
| [keyframes fixture](https://github.com/styled-components/vscode-styled-components/blob/main/src/tests/suite/colorize-fixtures/keyframes.js) 同时覆盖 `from`、`to` 和逗号分隔百分比步骤 | 将 CSS-B01、CSS-B02 作为一个小型 grammar corpus 的第一个 fixture，而不是只修 `from` |
| [functional media-query fixture](https://github.com/styled-components/vscode-styled-components/blob/main/src/tests/suite/colorize-fixtures/function-media-queries.js) 把 media、插值、嵌套 template 和 `.attrs()` 放进同一复现 | 用一条代表性组合用例覆盖交界，但不要让每个基础测试都背负复杂业务代码 |
| [#302](https://github.com/styled-components/vscode-styled-components/issues/302) 暴露 at-rule 候选提交时替换了整段已输入文本 | 对 `@`、`@med` 强制验证 edit range 和应用后的文本，而不仅仅检查候选列表包含 `@media` |
| [#435](https://github.com/styled-components/vscode-styled-components/issues/435) 表明媒体块内的 IntelliSense 会单独退化 | `@media` 名称、其 prelude 和其 block 内 CSS 必须分开测试；已有“不走伪类回退”断言不等价于 block 内属性补全 |
| [#292](https://github.com/styled-components/vscode-styled-components/issues/292) 表明 `.attrs(...)` 中的复杂括号可使后续整份文件高亮失真 | 每次扩展 grammar 的终止条件，都在 fixture 尾部放入普通 TS/JSX，确认 scope 能恢复 |
| [#388](https://github.com/styled-components/vscode-styled-components/pull/388) 显示 VS Code 升级会改变 scope/token 输出 | 不把上游或 VS Code 自身的完整 token 细节当作扩展契约；升级后先判断是自身语义回归，还是宿主 scope 漂移，再有意更新预期 |

结论是：fixture/golden 的价值在于记录真实故障，不在于把 CSS 语法表完整镜像一遍。yak 的 provider 与 grammar 分层更清楚，因此应把每个断言放在直接拥有该行为的层级。

## 新用户问题的收录流程

1. 将报告缩到一个可复制的最小源片段，保留宿主语言、tag 形态、光标位置、实际结果和期望结果。
2. 先分类：仅颜色或 scope 是 grammar；找不到 template、插值错位、edit 越界是模板/虚拟 CSS；候选缺失、错误替换、取消后残留是 provider；CSS data 本身没有候选则记录为上游或版本边界。
3. 在实际所有者处加入最小回归。只有问题跨层时才同时添加多层测试。
4. 如果该片段代表一个新的风险交界，在本文矩阵补一行；若只是已有单元格的新实例，则只新增 fixture，避免膨胀主 TODO。
5. 修复后执行相关窄测试，最终执行 `yarn verify`；在 issue 或变更说明中写明 fixture 覆盖的行为，而不是笼统地声称“支持全部 CSS”。

建议每个 fixture 都回答四个问题：它保护什么用户行为、哪个层拥有该行为、最相邻的反例是什么、为何这不是已有 fixture 的重复。

## 何时可视为 P1 完成

P1 可以关闭的条件不是“再也不会收到 CSS 问题”，而是以下可验证状态同时成立：

- CSS-B01 至 CSS-B08 都有明确的实现和自动化回归。
- grammar 覆盖四种宿主语言中的 keyframe step 和编辑中间态，并包含模板后的宿主语法恢复断言。
- Extension Host 覆盖 `@`、`@med`、嵌套分组规则、一个 descriptor 规则、负向隔离区、replacement range 和 cancellation。
- 所有新 Language Service 结果均通过完整 virtual-to-source range 校验；插值和 wrapper 不会产生 edit 或 hover。
- `yarn test`、`yarn test:integration` 和 `yarn verify` 通过。
- CSS Language Service 或 VS Code 升级时，重新运行该 corpus；token scope 变化必须经过人工分类后才更新预期。

达到这些条件后，新 bug 仍可能出现，但将有稳定的入口：它要么属于已有矩阵中的一个最小新 fixture，要么揭示一个应显式新增的风险维度，而不是回到无限增长的总 TODO。
