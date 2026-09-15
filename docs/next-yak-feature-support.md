# next-yak 编辑器功能支持结论

> 验证日期：2026-08-26
>
> 本文描述 `vscode-yak` 对 next-yak 源代码提供的编辑器能力，不代表
> next-yak 的构建转换或运行时兼容性结论。

## 结论

对于下列 next-yak 功能，`vscode-yak` 没有完全缺失的项目：每项都至少支持
CSS 模板识别、代码高亮或 CSS 自动补全。不过，“支持模板”不等于每一个动态
表达式内部都提供 CSS 功能；`${...}` 始终保留给 TypeScript/JavaScript 语言服务。

| 功能 | 代码高亮 | CSS 自动补全 | 结论与边界 |
| --- | --- | --- | --- |
| `styled` 静态样式 | 支持 | 支持 | 支持 CSS 属性、值、函数、伪类、伪元素和 at-rule。 |
| `styled` 动态样式 | 支持静态部分和嵌套 `css` | 支持静态部分和嵌套 `css` | `${...}` 表达式内部交给 TypeScript/JavaScript；表达式前后和嵌套 `css` 模板仍是 CSS 区域。 |
| `css` tagged template | 支持 | 支持 | 支持直接、命名空间和嵌套 `css` 模板。 |
| `css` prop | 支持 | 支持 | 支持 `css={css\`...\`}`；项目需配置 `jsxImportSource: "next-yak"` 或使用文件级 pragma。 |
| `keyframes` | 支持 | 支持 | `from`、`to` 和百分比步骤会高亮，步骤内 CSS 属性可补全。 |
| `.attrs` | 支持 | 支持 | `styled.input.attrs(...)` 及 `styled(Component).attrs<...>(...)` 的模板主体可用；`.attrs` 参数由 TypeScript/JavaScript 处理。 |
| 组件引用 | 支持外层静态 CSS | 支持外层静态 CSS | `${Button}` 本身是插值边界，不解析组件实现或提供组件选择器补全。 |
| mixins | 支持 | 部分支持 | 静态 `css` mixin 可作为本地或跨文件导出 mixin 提示；动态 mixin 可编辑，但不会进入跨文件 mixin 索引。 |
| `globalStyle` | 支持 | 支持 | `globalStyle` 可识别；迁移前 `createGlobalStyle` 也会归一化为同一内部模板类型。 |

## 动态样式的实际行为

以下代码中的三个区域属于不同语言服务：

```tsx
export const DynamicCssMigrationButton = styled.button<{ $primary: boolean }>`
  background: #BF4F74;

  ${(props) =>
    props.$primary
      ? css`
          color: white;
        `
      : css`
          color: #BF4F74;
        `}
`
```

- `background: #BF4F74;` 是 CSS，具有高亮、补全、hover、诊断、代码操作和颜色功能。
- `${(props) => ...}` 是 TypeScript/JavaScript，交由内置语言服务处理。
- 两个嵌套的 `css\`...\`` 模板重新进入 CSS 区域，具有高亮和补全。

此模式已在 TextMate scope 和 Extension Host 补全测试中验证。

## 已知边界

- CSS 补全、hover、诊断、代码操作和颜色功能不会进入 `${...}` 插值本体，以避免把动态 TypeScript/JavaScript 错当成 CSS。
- 动态 mixin 不会成为跨文件补全候选；只有无插值的 `css` 模板会进入静态 mixin 索引。
- 组件引用场景会识别外层模板及静态 CSS，但不会解析 `${Button}` 对应组件的样式关系。
- TextMate 高亮是静态规则。常规的 `styled`、`css`、`keyframes`、`globalStyle` 可高亮；任意导入别名的语义识别由 AST 完成，TextMate 不会猜测别名来源。
- `.withConfig` 是 next-yak 上游明确不支持的 API；当前 AST 语言服务可识别其模板，但 TextMate 不会将其主体静态标为 CSS。
- next-yak 上游明确不支持 object syntax、`as` prop 和动态选择整个 `css` prop。扩展能识别其中个别 `css` 模板，不代表 next-yak 运行时支持这些写法。

## 手动测试样例

[test-workspace/example.tsx](../test-workspace/example.tsx) 汇集了迁移文档中的手动测试片段，当前包含：

- 20 个 `styled` 模板。
- 12 个 `css` 模板。
- 2 个 `keyframes` 模板。
- 2 个 `globalStyle` 模板。

启动 Extension Development Host 后，在这些模板中的静态 CSS 位置触发补全或 hover，即可验证对应能力。

## 验证记录

```sh
yarn vitest run test/migrationFromStyledComponents.test.ts test/grammar.test.ts
# 66 passed

yarn exec tsc --noEmit --project test-workspace/tsconfig.json
# passed

yarn test:integration
# passed
```

关联实现与测试：

- [test/migrationFromStyledComponents.test.ts](../test/migrationFromStyledComponents.test.ts)：迁移样例和真实手动 fixture 的模板识别回归。
- [test/grammar.test.ts](../test/grammar.test.ts)：TextMate CSS 高亮范围。
- [test/integration/extensionHost.ts](../test/integration/extensionHost.ts)：真实 Extension Host 内的 CSS 补全、hover、诊断、代码操作和项目 mixin 测试。
- [docs/migration-from-styled-components-compatibility.md](migration-from-styled-components-compatibility.md)：逐段迁移示例的更详细兼容性矩阵。
