# next-yak VS Code 扩展 TODO

> 更新日期：2026-08-24。
>
> 本清单以当前仓库代码、单元测试、Extension Host 集成测试和竞品分析为准，`[x]` 表示已实现并至少经过现有验证，`[ ]` 表示尚未实现或尚未达到可发布标准。
>
> 每个勾选项只描述一个可验证的工作结果，以便在实现后直接勾选而不混淆范围。

## 开发约定：TypeScript 优先

**项目中所有手写的可执行源码，包含扩展实现、测试、测试启动器与构建配置，默认均使用 TypeScript。** 只有外部运行时接口确实无法使用 TypeScript，或使用 TypeScript 会造成明显不合理的实现负担时，才可使用 `.js`、`.cjs` 或 `.mjs`；此类例外必须在相邻文档中说明运行时约束。

由构建工具生成的 CJS 或 ESM 产物不属于手写源码。例如，VS Code Extension Host 所需的 `.vscode-test/compiled/integration/extensionHost.cjs` 由 TypeScript 测试入口经 `tsdown.tests.config.ts` 生成，不在仓库中手工维护。

当前唯一的手写 JavaScript-family 文件是 `test-workspace/next-yak-example.jsx`，它是验证扩展 JavaScript/JSX 宿主语言支持的 fixture，而不是扩展、测试或构建逻辑；因此保留 JSX 语法。

## 优先级约定

- **P0**：正确性、回归防护和稳定发布所需的基础能力。
- **P1**：用户在日常编写 CSS 时直接感知的核心语言功能。
- **P2**：next-yak 专属 API、复杂模板形态和项目级 CSS 智能能力。
- **P3**：性能、兼容性、发布工程和长期维护质量。
- **P4**：跨编辑器复用、深度语义集成和可选的长期探索方向。

## P0：正确性与可测试性

### 已完成

- [x] 已向 TypeScript、TSX、JavaScript 和 JSX 文档注入 next-yak 的 CSS TextMate grammar。
- [x] 已在静态 next-yak 模板中提供 CSS 属性、值、函数、at-rule 和自定义属性补全。
- [x] 已通过 TypeScript AST 确认补全目标的 import binding 来自 `next-yak`。
- [x] 已支持 `import { styled, css, globalStyle, keyframes } from 'next-yak'` 的直接具名导入。
- [x] 已支持 `import { styled as s } from 'next-yak'` 形式的具名别名导入。
- [x] 已支持 `import * as yak from 'next-yak'` 形式的命名空间导入。
- [x] 已支持 `styled.div`、`styled(Component)` 和 `yak.styled.div` 形式的 styled 模板。
- [x] 已支持带类型参数的 styled 模板，例如 `styled.div<Props>\`...\``。
- [x] 已支持 `.attrs(...)` 链后的 styled 模板，例如 `styled.div.attrs({})\`...\``。
- [x] 已排除函数参数、局部变量等同名 `styled` 对 import binding 的遮蔽。
- [x] 已将模板插值替换为等长且保留换行的空白文本以维持 offset 对齐。
- [x] 已在 `${...}` 插值内部返回 `undefined` 以让原生 JavaScript 或 TypeScript 补全接管。
- [x] 已将虚拟 CSS 的 completion text edit 映射回宿主 TS、TSX、JS 或 JSX 文档范围。
- [x] 已在根级 `a:` 选择器上下文返回 `:hover`、`:focus` 等伪类候选。
- [x] 已在根级 `a::` 选择器上下文返回 `::before`、`::after` 等伪元素候选。
- [x] 已避免已知 CSS 属性和自定义属性误走伪类/伪元素补全回退路径。
- [x] 已为 next-yak CSS 候选设置优先排序以降低 Emmet JSX 候选遮挡属性补全的影响。
- [x] 已使用 Vitest 覆盖模板定位、别名、命名空间、遮蔽、插值和位置映射等纯函数行为。
- [x] 已使用 `@vscode/test-electron` 覆盖真实 TSX 文档中的属性、伪类、伪元素、别名、命名空间和遮蔽补全行为。
- [x] 已将 `yarn verify` 配置为类型检查、单元测试、Extension Host 测试和 VSIX 打包的全链路门禁。
- [x] 已为 JavaScript、JSX、TypeScript 和 TSX 四种宿主语言运行真实 Extension Host 属性补全回归测试。
- [x] 已为 `globalStyle`、`keyframes`、`styled(Component)`、`.attrs(...)` 和静态字符串 element access 运行真实 Extension Host 补全回归测试。
- [x] 已为 `css={css\`...\`}` 形式的 CSS prop、多个/相邻模板及嵌套 CSS 模板运行定位与补全回归测试。
- [x] 已为未闭合反引号、未闭合插值、语法错误 TSX 和不完整 CSS 添加不崩溃且范围安全的回归测试。
- [x] 已为未知属性、CSS value、媒体查询、自定义属性、复杂选择器和嵌套 selector 添加伪类回退正反例测试。
- [x] 已为单行 insert/replace range、snippet tab stop、跨多行模板映射及虚拟包装区/越界范围拒绝添加精确测试。
- [x] 已定义并测试 `import type`、重复 import、冲突 import 和无效 import 的识别行为。
- [x] 已决定支持静态字符串 element access，并拒绝动态 element access、动态 tag 名和无法静态解析的 wrapper 表达式。
- [x] 已为未保存 `untitled:`、只读内容提供器和远程式 URI 运行补全定位回归测试。
- [x] 已为已取消请求和 80 个 tagged template 上的连续补全请求建立 Extension Host 回归与 5 秒宽松延迟预算。
- [x] 已为 TextMate grammar 的静态误命中建立已知限制测试，避免将高亮 scope 误当作 AST 语义判断。

### 尚未完成

- [ ] 按文档 URI 与版本缓存 SourceFile、TypeChecker 或可复用绑定信息以避免每次补全都创建 TypeScript Program。
- [ ] 为 AST 缓存失效、文档修改和文档关闭建立回归测试以避免使用过期 import binding。
- [ ] 评估并记录 `typescript` compiler API 内联后约 8.9 MB bundle 的可接受预算与优化目标。
- [ ] 在不降低绑定识别正确性的前提下评估延迟加载、精简 parser 或替代绑定解析方案以缩小激活成本。

## P1：核心 CSS 语言体验

### Hover

- [ ] 注册 `HoverProvider` 以在静态 next-yak CSS 区域显示 CSS 属性、值、函数、伪类和伪元素说明。
- [ ] 将 CSS Language Service 的 hover range 从虚拟 CSS 文档准确映射回宿主文档。
- [ ] 在 `${...}` 插值位置和虚拟包装范围内明确返回 no hover。
- [ ] 将 CSS Language Service 的 Markdown hover 内容转换为 VS Code `MarkdownString` 并保留 MDN 链接。
- [ ] 为属性、值、函数、伪类、伪元素、keyframes 和无效 CSS 位置添加 hover 单元与 Extension Host 测试。

### 诊断

- [ ] 创建 `DiagnosticCollection` 以在 next-yak 模板中显示 CSS 语法和规则诊断。
- [ ] 调用 CSS Language Service `doValidation` 并将每个诊断范围映射回宿主文档。
- [ ] 过滤落在插值占位区、虚拟包装前缀和虚拟包装后缀中的误报诊断。
- [ ] 在文档变更、关闭、语言切换和扩展停用时正确更新或清理诊断集合。
- [ ] 提供扩展设置以允许用户关闭 next-yak CSS 诊断而不影响补全。
- [ ] 为未知属性、缺少分号、未闭合值、嵌套规则、插值相邻语法和 keyframes 添加诊断回归测试。

### 快速修复与代码操作

- [ ] 注册 `CodeActionProvider` 以暴露 CSS Language Service 提供的属性拼写等快速修复。
- [ ] 将 CSS code action 的文本编辑、诊断引用和 workspace edit 范围安全映射回宿主文档。
- [ ] 拒绝任何触及插值占位区、虚拟包装区或多行不安全范围的 code action。
- [ ] 为拼写修复、无可用修复、插值附近修复和多项修复添加 Extension Host 测试。

### 颜色能力

- [ ] 注册 `DocumentColorProvider` 以在 next-yak CSS 中显示颜色装饰并支持颜色选择器。
- [ ] 将 CSS 颜色信息范围从虚拟 CSS 文档映射回宿主文档。
- [ ] 注册颜色表示转换以支持 hex、rgb、rgba、hsl 和命名颜色之间的替换。
- [ ] 排除插值、注释和字符串中的伪颜色文本以避免错误的颜色装饰。
- [ ] 为静态颜色、alpha 颜色、命名颜色、渐变颜色和插值颜色添加测试。

### CSS 配置与数据

- [ ] 支持读取用户配置的 CSS custom data 文件以扩展项目私有属性、伪类和属性值补全。
- [ ] 在 custom data 文件变更后刷新 CSS Language Service 配置和补全缓存。
- [ ] 支持映射 CSS Language Service 的 lint 配置并为 next-yak 提供独立的设置命名空间。
- [ ] 为自定义 CSS 属性、设计系统值和失效 custom data 路径添加集成测试。

## P2：next-yak 专属体验

### API 覆盖

- [ ] 为 next-yak 官方支持的 `css` prop tagged template 提供高亮、补全、hover 和诊断 fixture。
- [ ] 评估并实现 `css={{ ... }}` 对象语法的 TypeScript 属性补全、类型错误展示和文档提示。
- [ ] 为静态 `css` mixin 在同文件和跨文件导入场景中添加补全与诊断回归测试。
- [ ] 为动态 `css` mixin、嵌套 `css` 模板和条件样式块添加插值边界回归测试。
- [ ] 为 `${Button}` 等 styled component selector 引用添加高亮、补全和诊断行为定义。
- [ ] 为 `${atoms(...)}`、`${theme => ...}` 等 next-yak 常见插值保留 TypeScript 语言服务优先级并添加 fixture。
- [ ] 为 `globalStyle` 中不支持的 runtime interpolation 提供针对 next-yak 约束的清晰诊断或文档提示。
- [ ] 为 `keyframes` 中的 `from`、`to`、百分比步骤和 `animation` 值建立专门的补全与诊断测试。
- [ ] 为 `styled(Component)`、泛型组件和组件链式 `.attrs(...)` 添加真实 next-yak 项目 fixture。
- [ ] 为上游 next-yak 新增或废弃 API 建立版本兼容矩阵并在升级时更新 fixture。

### 模板识别与高亮一致性

- [ ] 使 TextMate grammar 支持已被 AST 补全识别但尚未高亮的 next-yak 模板形态。
- [ ] 为 `styled.div<Props>`、`.attrs(...)`、命名空间 API 和 CSS prop 形式验证高亮 scope 是否与补全范围一致。
- [ ] 在不依赖 import 解析的前提下使用 semantic tokens 或 decorations 降低 TextMate 静态误高亮的可见影响。
- [ ] 为 TypeScript、TSX、JavaScript 和 JSX 的 grammar token 化结果建立快照或 scope 回归测试。
- [ ] 确保 TextMate grammar 继续使用 CSS scope 而不承诺 Sass、SCSS 或 Less 的编译支持。

### 项目级 CSS 智能能力

- [ ] 索引工作区中定义的 CSS 自定义属性并在 next-yak 模板中建议 `var(--token)`。
- [ ] 为工作区 CSS 自定义属性提供跳转定义、查找引用和 hover 来源信息。
- [ ] 索引同项目内的静态 CSS mixin 并在插值位置提供可用 mixin 建议。
- [ ] 为设计 token、CSS Modules 和全局 CSS 文件定义明确的索引范围与优先级规则。
- [ ] 在文件变更、删除、重命名和工作区文件夹变更时增量更新项目索引。
- [ ] 为大型工作区设置索引上限、取消机制和状态提示以避免影响编辑器响应。

### 可配置性

- [ ] 提供设置以声明经过确认的额外 next-yak wrapper tag 名而不将任意模板误判为 CSS。
- [ ] 提供设置以配置额外的 next-yak import module specifier，例如内部封装库的稳定入口。
- [ ] 提供设置以启用或禁用伪类回退、Emmet 排序优先、颜色装饰和项目索引等可选体验。
- [ ] 为每个设置提供默认值、作用域、迁移说明和 Extension Host 配置变更测试。

## P3：性能、兼容性与发布工程

### 性能与可靠性

- [ ] 为输入单字符、连续输入、手动触发补全和大文件补全定义可测量的延迟预算。
- [ ] 为包含数百个 tagged template 的文件添加性能基准以监控 AST 解析和 CSS 补全成本。
- [ ] 为多光标、快速编辑、撤销重做和 provider cancellation 添加稳定性测试。
- [ ] 为超长插值、深层嵌套对象、正则字面量和嵌套模板字面量添加插值扫描压力测试。
- [ ] 为异常 CSS Language Service 返回值、损坏 custom data 和 TypeScript parser 异常添加降级行为测试。
- [ ] 在开发模式中提供可选的调试日志开关以定位模板识别、虚拟 CSS 和范围映射问题。

### 兼容性矩阵

- [ ] 在扩展声明的最低 VS Code 版本、当前稳定版和 Insiders 版本上运行自动化测试。
- [ ] 在 macOS、Linux 和 Windows 上运行单元测试、Extension Host 测试和 VSIX 安装测试。
- [ ] 在 Node、TypeScript 和 VS Code API 升级时验证 CJS bundle 仍可由 Extension Host 加载。
- [ ] 在本地工作区、远程 SSH、Dev Container、Codespaces 和虚拟工作区中验证文档 URI 与测试路径处理。
- [ ] 在没有安装 `next-yak` 包或 TypeScript 语言服务报错的项目中验证扩展不会影响普通编辑行为。

### CI 与质量门禁

- [ ] 配置 GitHub Actions 在 pull request 上执行 `yarn verify`。
- [ ] 配置依赖更新检查并在 TypeScript、VS Code API 和 CSS Language Service 升级时运行完整测试矩阵。
- [ ] 配置测试覆盖率报告并为模板识别、范围映射和伪类回退设定最低覆盖目标。
- [ ] 配置 markdown、JSON、package manifest 和 VSIX 内容检查以防止发布配置回归。
- [ ] 为 test fixture 创建命名规则和最小化原则以避免测试数据难以维护。
- [ ] 为竞品功能差距、上游 next-yak 版本和已知限制建立定期复审节奏。

### 发布准备

- [ ] 注册 Marketplace publisher 并将当前 `local` publisher 替换为正式发布者。
- [ ] 增加扩展图标、Marketplace 截图、关键词、分类和清晰的功能说明。
- [ ] 为每个发布版本维护面向用户的 CHANGELOG 条目和升级说明。
- [ ] 在发布前从干净目录安装生成的 VSIX 并执行手工 smoke test。
- [ ] 为版本号、预发布版、稳定版、回滚和 VSIX 校验和制定发布流程。
- [ ] 评估 TypeScript compiler API 内联带来的 VSIX 体积并在发布说明中记录必要的体积变化。
- [ ] 配置安全扫描、许可证检查和依赖漏洞通知以维护打包依赖的发布质量。

### 文档与支持

- [ ] 在 README 中加入带截图的安装、启用、补全、伪类、插值和故障排查示例。
- [ ] 在 README 中说明 AST 补全语义识别与 TextMate 高亮静态识别之间的行为差异。
- [ ] 在 README 中说明 next-yak 模板支持标准 CSS nesting 但不承诺 Sass、SCSS 或 Less 预处理器语法。
- [ ] 为常见问题建立排查步骤，包括扩展未激活、补全为空、Emmet 干扰、工作区 TypeScript 和 custom data 配置。
- [ ] 提供最小复现 issue 模板以收集 VS Code 版本、next-yak 版本、宿主文件语言和模板代码。

## P4：长期探索

- [ ] 在需要支持 Neovim、Zed 或其他编辑器时将模板定位、虚拟 CSS 映射和语言功能抽取为独立 LSP。
- [ ] 仅在必须进入 TypeScript 原生导航或诊断管线时评估 next-yak 专用 tsserver plugin 的成本与用户配置负担。
- [ ] 支持跨文件 re-export、barrel import 和项目类型信息驱动的 next-yak binding 解析。
- [ ] 提供 CSS 自定义属性、mixin、component selector 和设计 token 的跨文件定义跳转与引用查找。
- [ ] 提供将 styled-components 代码迁移到 next-yak 的代码操作并遵守 next-yak 的动态样式限制。
- [ ] 提供将可安全提取的 next-yak 静态样式迁移为原生 CSS 或 CSS Modules 的辅助操作。
- [ ] 评估 CSS formatter 集成是否能在不破坏模板插值和 next-yak 编译约束的前提下格式化样式块。
- [ ] 评估仅在 next-yak 上游明确支持并测试后提供可选 SCSS 或 Less 编辑模式的需求。

## 已确认的边界

- [x] 当前扩展承诺 next-yak 的标准 CSS、现代 CSS nesting、媒体查询和 keyframes，而不承诺完整 Sass、SCSS 或 Less 语法。
- [x] 当前扩展不会通过全局关闭 `typescriptreact` 或 `javascriptreact` 的 Emmet 来解决局部模板候选冲突。
- [x] 当前扩展优先保持独立 VS Code 扩展架构，而不要求用户配置工作区 TypeScript 或 tsserver plugin。
- [x] 当前扩展将补全的 import 来源判断与高亮的 TextMate 静态匹配视为两个不同可靠性层级。

## 完成规则

- [ ] 每项功能完成前都应至少有一个针对成功路径的自动化测试。
- [ ] 每项涉及宿主文档映射的功能完成前都应至少有一个针对插值边界或无效范围的自动化测试。
- [ ] 每项修改用户可见行为的功能完成前都应在 README 或对应设计文档中更新说明。
- [ ] 每次准备发布前都应运行 `yarn verify` 并在干净环境安装生成的 VSIX 做 smoke test。
