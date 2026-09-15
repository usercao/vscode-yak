# styled-components 迁移示例兼容性测试矩阵

> 验证日期：2026-08-26
>
> 参考页面：[Migration from styled-components](https://yak.js.org/docs/migration-from-styled-components)
>
> 固定源文档：[migration-from-styled-components.mdx @ 1a5a828](https://github.com/DigitecGalaxus/next-yak/blob/1a5a828104d5b7c08f7ab578ae9d86a8437180cd/docs/content/docs/migration-from-styled-components.mdx)

本报告记录的是 `vscode-yak` 对迁移页面示例的编辑器支持情况，而不是对
`next-yak` 编译器的运行时兼容性认证。测试覆盖集中在：

- 由 `next-yak` 和 `styled-components` 导入绑定到的 `styled`、`css`、`keyframes`、`globalStyle` 模板识别。
- 模板中的静态 CSS、嵌套 `css` 模板和插值边界。
- 静态 mixin 的项目索引资格。
- TextMate 静态高亮与 AST 语义识别的已知差异。
- 页面中不含 CSS tagged template 的配置、辅助文件和伪代码的语法有效性。

测试实现位于 [test/migrationFromStyledComponents.test.ts](../test/migrationFromStyledComponents.test.ts)，`.withConfig` 的静态高亮边界位于 [test/grammar.test.ts](../test/grammar.test.ts)。

## 判定标准

| 状态 | 含义 |
| --- | --- |
| 已验证 | 扩展可通过 TypeScript AST 确认导入来源并识别对应模板；静态 CSS 可进入现有 CSS 语言服务路径。 |
| 已验证，动态边界 | 模板及其静态 CSS 可识别；`${...}` 内的运行时表达式会被遮蔽，扩展不会在插值内部提供 CSS 功能。 |
| 仅语法验证 | 这是 Next.js、TypeScript 或 next-yak 构建期配置，不会产生扩展的 CSS 模板区域。 |
| 上游不支持 | next-yak 页面明确列为未支持；本扩展不会将模板识别误表述为该运行时 API 可用。 |
| 部分支持 | 语义模板识别与 TextMate 静态高亮的结果不同，或存在明确的索引边界。 |

## Tagged Template 示例

| 页面示例 | 覆盖的测试项 | 当前结果 | 说明 |
| --- | --- | --- | --- |
| `styled-components` 默认 `styled` 改为 `next-yak` 具名 `styled` | `recognizes both sides of the documented import change` | 已验证 | 旧、新导入均由各自 Profile 识别为 `styled`。 |
| 同一导入替换中的 `css` 与 `keyframes` | `recognizes both sides of the documented import change` | 已验证 | 三个导出在两侧均解析为正确的内部模板类型。 |
| 静态组件样式 | `static-component-styles` | 已验证 | 包括静态声明、`&:hover` 嵌套规则和 CSS 函数。 |
| 静态 mixin | `static-mixins` | 已验证 | `css` 与使用它的 `styled.div` 均被识别；静态本地和导出的 mixin 都可进入项目索引。 |
| keyframes 和动画插值 | `keyframes` | 已验证，动态边界 | `keyframes` 与 `styled.div` 都被识别；`${rotate}` 不作为静态 CSS 分析。 |
| 组件引用 `${Button}` | `component-references` | 已验证，动态边界 | 外层 CSS 及静态嵌套规则可用；组件引用本身由插值边界保护。 |
| 原生元素 `.attrs(...)` | `intrinsic-attrs` | 已验证 | `styled.input.attrs(...)` 链可被 AST 识别为 `styled`。 |
| 包装组件 `.attrs<...>(...)` | `wrapped-component-attrs` | 已验证 | 泛型和 `styled(Button)` 调用链均可识别。 |
| `as` 的 `HtmlTag` 类型安全替代方案 | `type-safe-as-alternative` | 已验证 | 两段文档代码组合为一个 TSX fixture；`styled(HtmlTag)` 可识别为 `styled`。 |
| 动态 CSS 属性值 | `dynamic-property-values` | 已验证，动态边界 | 外层模板可用，属性值回调被安全遮蔽。 |
| 动态 CSS 属性需要嵌套 `css` | `dynamic-css-properties` | 已验证，动态边界 | 外层 `styled` 与条件分支中的两个 `css` 模板均被发现。 |
| 动态 mixin | `dynamic-mixins` | 已验证，动态边界 | 同文件中的外层 `styled` 与嵌套 `css` 模板可识别。 |
| 动态 mixin 移入组件文件 | `dynamic-mixins-moved-into-component-file` | 已验证，动态边界 | 与页面建议一致：同文件模板可识别。动态 mixin 不会进入跨文件静态 mixin 索引。 |
| 原来的跨文件动态 `mixin.ts` | `recognizes the documented styled-components dynamic mixin input before migration` | 已验证为迁移前输入 | `styled-components` 的 `css` 模板可识别，用于验证迁移前后的 Profile 边界。 |
| `createGlobalStyle` 改为 `globalStyle` | `global-styles` 和导入替换测试 | 已验证 | `createGlobalStyle` 在旧 Profile 中归一化为 `globalStyle`；`next-yak` 的 `globalStyle` 直接可识别。 |
| 原生 CSS transpilation mode 下的外部选择器 | `external-styles-native-css-mode` | 已验证 | 扩展可识别模板和静态 CSS；是否使用原生 CSS 模式由 next-yak/Next 配置决定。 |
| CSS Modules 下的 `:global(...)` | `external-styles-global-selector` | 已验证 | CSS 模板可识别；`next-yak` 页面已将该迁移方式标为 deprecated。 |
| 用属性回调代替生成样式的函数 | `style-generating-function-replacement` | 已验证，动态边界 | 外层 `styled` 可识别；`${(props) => props.$color}` 不在静态 CSS 服务范围内。 |
| 静态 `css` prop | `static-css-prop` | 已验证 | JSX 属性中的 `css` tagged template 可识别。 |
| 含动态属性值的 `css` prop | `dynamic-css-prop-value` | 已验证，动态边界 | `css` 模板可识别，`${() => color}` 会被遮蔽。 |
| 从 `.yak.ts` 导入计算值 | `calculated-values-from-yak-file` | 已验证，动态边界 | 外层 `styled` 模板可识别；扩展不会执行 `.yak.ts` 的构建期计算。 |
| 与 styled-components 混用时的 `&&` 特异性 | `styled-components-specificity` | 已验证 | `styled(StyledComponentsButton)` 和 `&&` CSS 规则可识别。 |

## 配置、辅助文件和伪代码

下列页面代码块没有可供扩展识别的 CSS tagged template。测试会检查它们可被解析，且不会被误判为 CSS 编辑区域；这不是对 Next.js 或 next-yak 构建产物的断言。

| 页面示例 | 覆盖的测试项 | 当前结果 | 说明 |
| --- | --- | --- |
| `layout.tsx` 中由 `<GlobalStyle />` 改为 `import "./globals"` | `global-styles-layout-import` | 仅语法验证 | 模块导入时机由应用运行时决定。 |
| `withYak` 的 `transpilationMode: "Css"` | `native-css-transpilation-config` | 仅语法验证 | 扩展不读取或执行 Next 配置。 |
| `allColors` 静态对象 | `static-style-options` | 仅语法验证 | 普通 TypeScript 数据结构，不产生模板区域。 |
| `tsconfig.json` 的 `jsxImportSource: "next-yak"` | `parses the documented tsconfig jsxImportSource setting` | 仅语法验证 | JSON 设置可解析；扩展不会替用户修改或验证项目 JSX 类型配置。 |
| `/** @jsxImportSource next-yak */` | `css-prop-file-pragma` | 仅语法验证 | pragma 属于 TypeScript JSX 类型检查范围。 |
| `constants.yak.ts` 的计算值 | `calculated-values-yak-file` | 仅语法验证 | Yak 文件求值属于 next-yak 构建期。 |
| next-yak debug 配置 | `debug-config` | 仅语法验证 | 扩展不消费 `withYak` 的 debug 输出。 |
| 动态属性值转换后的 `transformed.tsx` 伪代码 | `dynamic-property-value-transformation` | 仅语法验证 | 仅检查文档伪代码的 TSX 语法，不断言 CSS variable 输出。 |
| 动态 `css` 转换后的 `transformed.tsx` 伪代码 | `dynamic-css-property-transformation` | 仅语法验证 | 仅检查文档伪代码的 TSX 语法，不断言 className 输出。 |

## 当前不支持或有边界的能力

### next-yak 上游明确未支持

| 能力 | 当前结论 | 本扩展的处理 |
| --- | --- | --- |
| Object syntax | 上游不支持 | `styled.div({ color: "red" })` 没有 CSS tagged template，扩展不会建立 CSS 编辑区域。 |
| 动态选择整个 `css` prop | 上游不支持 | 条件分支中的各个 `css` 模板可被语义识别，但这不表示 next-yak 运行时支持 `css={condition ? css\`...\` : css\`...\`}`。 |
| `as` prop | 上游不支持 | 页面给出的 `HtmlTag` 替代方案可识别；扩展不验证 JSX `as` API。 |
| `.withConfig` | 上游不支持 | 语义 AST 路径目前可将链式模板识别为 `styled`，但 TextMate 静态高亮不会嵌入 CSS，见下一节。 |

### vscode-yak 的已知边界

- 动态插值中的内容不进入 CSS 补全、hover、诊断、代码操作或颜色服务。这是刻意的安全边界，静态 CSS 在插值前后仍可用。
- 只有无插值的 `css` 模板才会作为静态 mixin 索引；动态 mixin 不会被提供为跨文件 mixin。这与页面对跨文件动态 mixin 的限制一致。
- `.withConfig(...)` 的 AST 语义识别与 TextMate grammar 不一致：语言服务可以从 AST 找到模板，但静态高亮不会把该模板主体标成 CSS。`test/grammar.test.ts` 已锁定此行为。
- 扩展不执行 `withYak`、Next.js、PostCSS 或 `.yak.ts`，因此不能验证页面描述的 CSS Modules、原生 CSS 转译、构建期变量和 debug 输出。

## 已执行验证

```sh
yarn vitest run test/migrationFromStyledComponents.test.ts
# 35 passed

yarn vitest run test/grammar.test.ts
# 30 passed

yarn check
# passed
```

要验证 next-yak 本身的编译转换和运行时限制，需要在独立的 Next.js fixture 中安装并执行固定版本的 `next-yak`。本仓库当前的测试结果只能说明 `vscode-yak` 对迁移源代码提供的编辑器能力。
