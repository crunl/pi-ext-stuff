# statusline 与 tool-result-budget

本文覆盖 monorepo 中两个相互独立的扩展：`extensions/statusline/`（pi 全局 TUI 状态行）与
`extensions/tool-result-budget/`（单回合工具结果字符预算）。两者没有代码依赖：statusline 是纯
展示层扩展，tool-result-budget 只在 `tool_result` 事件上缩减文本。全部结论均来自当前源码，
关键位置附 `路径:行号`。

## 一、总览

| | statusline | tool-result-budget |
|---|---|---|
| 入口 | `extensions/statusline/index.ts`（转发到 `src/index.ts`） | `extensions/tool-result-budget/index.ts` |
| 源码 | `src/` 下 8 个文件，共 725 行 | 单文件 `index.ts`，180 行 |
| 测试 | `tests/` 5 个文件，25 个用例 | 无 |
| 依赖 | pi SDK + `packages/shared-tool-presentation` + Node 内建 | 仅 Node 内建 + pi SDK 的 `getAgentDir` |
| 配置 | 无扩展配置键；读取全局/项目 `settings.outputPad` | 3 个环境变量 |
| 作用时机 | 每帧 footer render | `turn_start` / `before_agent_start` / `tool_result` |

---

## 二、statusline

pi 的 TUI 状态行扩展：接管底部 footer，渲染一条 Catppuccin powerline 链（model / effort /
folder / branch）加右侧 token 与缓存统计。README 为中文（`extensions/statusline/README.md`），
本文是其配套的代码级说明。

### 2.1 注册与生命周期（`src/index.ts`，70 行）

- 包根 `extensions/statusline/index.ts:2` 只做转发：`export { default } from "./src/index.ts";`。
  `package.json` 没有 `pi` 字段，因此走 pi 的 `index.ts` 自动发现（`extensions/statusline/package.json`）。
- 默认启用：模块内 `let enabled = true;`（`src/index.ts:21`）。
- `install(ctx)`（`src/index.ts:36-42`）先做守卫：`if (!ctx.hasUI || ctx.mode !== "tui") return;`
  （`src/index.ts:37`），即非 TUI 环境完全不接管 footer。随后把 `ctx` 存进闭包变量
  `currentCtx`，并调用 `installFooter(ctx, { getModelInfo: modelInfo })`。
- `modelInfo`（`src/index.ts:27-34`）是惰性读取：从 `currentCtx.model` 取模型信息，喂给
  `resolveModelInfo({ modelId: model.name?.trim() || model.id, reasoning: Boolean(model.reasoning),
  thinkingLevel: ctx?.thinkingLevel })`。footer 每帧调用它，所以模型或 thinking level 变化后无需重建 footer。
- 事件订阅：
  - `pi.on("session_start")`（`src/index.ts:48-50`）：每个会话都安装一次，覆盖 `/resume`、fork
    与会话切换；`enabled` 为 false 时跳过。
  - `pi.on("model_select")`（`src/index.ts:53-55`）：仅刷新 `currentCtx`，footer 侧通过闭包读到新值。
- 命令 `/statusline`（`src/index.ts:57-67`）：翻转 `enabled`。开启时 `install` 并
  `ctx.ui.notify("statusline: custom footer enabled", "info")`；关闭时 `uninstall`，后者执行
  `ctx.ui.setFooter(undefined)`（`src/index.ts:43-45`）恢复 pi 内置 footer。

### 2.2 Footer 组成与段落顺序（`src/footer.ts`，198 行）

`installFooter`（`src/footer.ts:48`）通过 `ctx.ui.setFooter((tui, theme, footerData) => {...})`
（`src/footer.ts:55`）注册一个 footer 组件对象，其 `render(width)` 返回字符串行数组。

左侧 powerline 链按固定顺序拼装（`src/footer.ts:77-99`）：

1. **model**：`ICONS.model ${model.modelId}`，前景色 `pal.fixed.model`（`src/footer.ts:78-82`）。
2. **effort**：仅当 `model.effort` 有值时加入，文本 `ICONS.effort ${model.effort}`，颜色
   `effortColor(model.effort, pal)`（`src/footer.ts:83-89`）。
3. **folder**：`ICONS.folder ${pwd}`，`pal.fixed.folder`（`src/footer.ts:90-94`）。`pwd` 来自
   `formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE)`
   （`src/footer.ts:64-67`），只展示末级目录名。
4. **branch**：仅当 `footerData.getGitBranch()` 非空时加入（`src/footer.ts:68`、`src/footer.ts:95-99`）。

分支变化通过 `footerData.onBranchChange(() => tui.requestRender())` 触发重绘，其返回值作为组件的
`dispose`（`src/footer.ts:56-60`）。

右侧统计按顺序拼接，用两个空格分隔（`src/footer.ts:157-158`）：

- **`CHxx.x%`**：最近一条 assistant message 的缓存命中率，文本 `CH${latestCacheHitRate.toFixed(1)}%`
  （`src/footer.ts:113`）。仅在 `(cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined`
  时显示（`src/footer.ts:110-111`）。
- **context meter**：`ctx.getContextUsage()`（`src/footer.ts:120`）非空时显示
  `ICONS.gauge ██░░░░░░░░ tokens/window`（`src/footer.ts:139`）。
  - meter 共 `METER_CELLS = 10` 格（`src/footer.ts:37`），填充格数由 `meterCells(pctValue, 10)` 给出。
  - 颜色阈值（`src/footer.ts:123-124`）：`pctValue >= 75` → `error`；`>= 50` → `warning`；否则 `success`。
    未填充的 `░` 固定用 `dim`（`src/footer.ts:131`）。
  - token 文本：`usage.tokens !== null` 时为 `${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`，
    否则 `?/${formatTokens(usage.contextWindow)}`（`src/footer.ts:134-138`）。

**第二行**（可选）：仅当有其他扩展的状态时追加（`src/footer.ts:184-192`）。状态来自
`footerData.getExtensionStatuses()`，先经 `syncPermissionsMode(...)` 过滤（`src/footer.ts:150-152`），
再按 `isHiddenExtensionStatus(key)` 二次过滤（`src/footer.ts:155`），按 key 字典序排序、把内嵌换行压成空格
后拼接（`src/footer.ts:185-188`）。

**宽度与 gutter**：

- gutter 宽度来自 `getOutputPad(ctx.cwd, ctx.isProjectTrusted())`（`src/footer.ts:164`），
  `innerWidth = Math.max(0, width - pad * 2)`（`src/footer.ts:166`）。
- 左右对齐交给 `alignLine(leftColored, visibleWidth(leftPlain), statsColored, visibleWidth(statsPlain), innerWidth)`
  （`src/footer.ts:168-174`）。放不下时 `rightFits === false`，此时**保留左侧并截断**，右侧统计整体消失：
  `truncateToWidth(leftColored, innerWidth, theme.fg("dim", "..."))`（`src/footer.ts:176-180`）。

### 2.3 powerline 渲染（`src/status-mode.ts`，81 行）

`powerlineChain(segments)`（`src/status-mode.ts:28-38`）把段落串成一颗 powerline 药丸：

- 相邻段落的分隔箭头为 `PL_SEP`，取值为 U+E0B0（右向实心箭头，`src/status-mode.ts:4`）。
- 首尾帽使用 half-circle 字符 `PL_LEFT` = U+E0B6、`PL_RIGHT` = U+E0B4，从
  `packages/shared-tool-presentation/src/badge.ts` 导入（`src/status-mode.ts:1`）。
- 每个 body 末尾补一个空格，第 2 段起在箭头后补一个前导空格，首段（model）左侧贴紧（`src/status-mode.ts:31-37`）。
- `cap()`（`src/status-mode.ts:40-44`）：帽用段落色作**前景**。
- `body()`（`src/status-mode.ts:46-51`）：正文用段落色作**背景**，文字颜色由
  `contrastTextFor(rgb)` 按亮度选黑或白（`src/status-mode.ts:49`）；颜色缺失时退化为反显
  `\x1b[7m…\x1b[27m`（`src/status-mode.ts:48`）。
- `sep()`（`src/status-mode.ts:53-62`）：箭头用左段色作前景、右段色作背景，从而叠出无缝过渡；左段无颜色时
  直接输出裸 `PL_SEP`（`src/status-mode.ts:55`）。

状态分区：`partitionExtensionStatuses(statuses)`（`src/status-mode.ts:64-74`）把 key 为
`pi-safety` 的项单独取出为 `mode`，其余为 `remaining`。`syncPermissionsMode`（`src/status-mode.ts:76-79`）
只返回 `remaining`，即 **footer 不显示 pi-safety 的文本状态**（权限状态由 pi-core 的 editor chrome 徽章呈现，
见 2.8）。注意 `PermissionsModeState` / `isPermissionsModeEvent` 只在测试里使用，`src/` 并未引用
（`extensions/statusline/src/` 内无匹配）。

### 2.4 model / effort（`src/model-info.ts`，20 行）

`resolveModelInfo`（`src/model-info.ts:9-19`）是纯函数、无 pi 依赖：

- `const level = input.thinkingLevel ?? "off"`（`src/model-info.ts:14`）。
- `effort = input.reasoning && level !== "off" ? level : undefined`（`src/model-info.ts:18`）。
  即 **非 reasoning 模型或 thinking 关闭（`"off"`）时 effort 为 `undefined`，footer 不渲染 effort 段**。

### 2.5 右侧统计的数据与格式（`src/usage.ts` 71 行、`src/format.ts` 87 行）

`computeUsageTotals(ctx)`（`src/usage.ts:18-63`）遍历 **全部** session entries
（`ctx.sessionManager.getEntries()`，`src/usage.ts:39`），累加四类计数
`{input, output, cacheRead, cacheWrite}`：

- assistant message（`src/usage.ts:40-48`）：累加 usage，并用最新一条重算
  `latestCacheHitRate = cacheRead / (input + cacheRead + cacheWrite) * 100`（`src/usage.ts:43-48`），
  分母为 0 时置 `undefined`。
- 带 usage 的 `toolResult` message（`src/usage.ts:49-54`）。
- 带 usage 的 `branch_summary` / `compaction` 条目（`src/usage.ts:55-59`）。

值得注意的是：footer 实际只渲染 `cacheRead`、`cacheWrite`、`latestCacheHitRate`
（`src/footer.ts:110-113`）；`input` 与 `output` 被累加但从未显示。

`src/format.ts` 的纯函数：

- `formatTokens`（`src/format.ts:14-25`）：`999 → "999"`，`12300 → "12.3k"`，`1500000 → "1.5M"`；
  数值 ≥100 时省略小数。
- `alignLine`（`src/format.ts:30-43`）：`minPadding` 默认 2（`src/format.ts:36`）。能容纳时
  `left + 空格填充 + right` 并返回 `rightFits: true`；否则只返回 `left`、`rightFits: false`。
- `formatCwd`（`src/format.ts:50-56`）：恰好等于 home 时返回 `"~"`，否则取路径末段；根目录 `/` 仍是 `/`。
- `meterCells`（`src/format.ts:84-87`）：`ceil(percent/100 * cells)`，先把 percent 夹到 0–100。
- `stripAnsi`（`src/format.ts:9-11`）：去掉 SGR 序列，供 `visibleWidth` 前测量代码点宽度。
- `ICONS`（`src/format.ts:59-67`）为 Nerd Font 码点：folder U+F024B、branch U+F0641、gauge U+F49B、
  cache U+F1C0、model U+F035B、effort U+F09D1。
- `HIDDEN_STATUS_KEYS = new Set(["pi-lens-lsp"])`（`src/format.ts:74`），`isHiddenExtensionStatus`
  （`src/format.ts:76-78`）按 key 匹配——pi-lens 每回合都会发布 LSP 状态，footer 丢弃它以保持单行。

### 2.6 output padding 同步（`src/output-pad.ts`，87 行）

footer 需要与聊天消息保持相同的左右留白，而 pi 的 footer API 不暴露 `outputPad`，因此本模块直接读
settings 文件：

- 路径：`agentDir()` = `PI_CODING_AGENT_DIR ?? ~/.pi/agent`（`src/output-pad.ts:21-23`），全局文件
  `<agentDir>/settings.json`，项目文件 `<cwd>/.pi/settings.json`（仅当项目被信任时）（`src/output-pad.ts:62-64`）。
- `readOutputPadFile`（`src/output-pad.ts:34-44`）：只有字面量 `0` 解析为 `0`，其余任何值（含缺失、解析失败）
  都是 `1`（`src/output-pad.ts:40`）。
- `effectiveOutputPad`（`src/output-pad.ts:47-52`）：项目键存在时优先，否则回退全局；最终仍按
  “`=== 0 ? 0 : 1`”归一（`src/output-pad.ts:51`）。
- `getOutputPad`（`src/output-pad.ts:62-80`）带 mtime 缓存：两个文件的 mtime 与缓存一致就直接返回，
  否则重读。这样 `/settings` 写入后下一帧即生效，无需 watch 定时器。
- `resetOutputPadCache`（`src/output-pad.ts:82-85`）是测试用的清缓存接口。

### 2.7 调色板系统（`src/palette.ts`，113 行）

双主题 Catppuccin，按终端明暗选择：

- `PALETTE_DARK` = Frappé（`src/palette.ts:54-68`，注释称对应 live theme `catppuccin-frappe`）。
  - fixed：model `#ca9ee6`（mauve）、folder `#99d1db`（sky）、git `#e5c890`（yellow）。
  - effort：minimal `#a6d189`（green）→ low `#8caaee`（blue）→ medium `#f2d5cf`（rosewater）→
    high `#eebebe`（flamingo）→ xhigh `#ef9f76`（peach）→ max `#f4b8e4`（pink）。
- `PALETTE_LIGHT` = Latte（`src/palette.ts:71-85`；提交 `880d6de` 起同色相压深，见下）。
  - fixed：model `#8839ef`（mauve，不变）→ folder `#00787f`（深青）→ git `#a25c00`（深赭）。
  - effort：minimal `#148002`（深绿）→ low `#0761ef`（深蓝）→ medium `#4564d5`（深宝石蓝）→
    high `#ae4f51`（砖红）→ xhigh `#ca3700`（深橙红）→ max `#b03f95`（深品红）。

  压深的理由（`src/palette.ts:11-31`）：Latte accent 本是前景色，直接做 pill 底在浅底上对比度
  不足（旧 git 黄块 vs 底仅 2.31、白字 vs 旧 teal/green 仅 3.74/3.34）。故 Light 每档沿色相压深，
  直至同时满足"前景 vs 底 ≥4.5 且白字 vs 块 ≥4.5"；压深后 YIQ 全 <128，白字是既有
  `contrastTextFor` 规则的自然输出，无需改规则。model `#8839ef` 本已达标故不动。
  此前的 rosewater/lavender 选色分析见第五节第 1、6 条的后续注记（已被本轮取代）。
- `EffortLevel` 类型为 `"minimal" | "low" | "medium" | "high" | "xhigh" | "max"`（`src/palette.ts:40-46`）。

明暗检测（`isLightThemeFrom`，`src/palette.ts:82-94`）：

- pi 对自定义主题没有 `isLight` API，因此读 live theme 的 `userMessageBg` 背景 ANSI：
  `theme?.getBgAnsi?.("userMessageBg")`（`src/palette.ts:100`），用 `parseTruecolor` 解析为 RGB。
- 判据是 YIQ 亮度 `(299r + 587g + 114b) / 1000 >= 128`（`src/palette.ts:104`）。
- 解析不到颜色或抛错时返回 `false`（即按 dark 处理）（`src/palette.ts:102`、`src/palette.ts:105-107`）。
  注释给出参照值：Latte 的 `userMessageBg`（mantle）约 232 luma，Frappé 约 42（`src/palette.ts:93-94`）。

其余导出：`paletteForLight(isLight)`（`src/palette.ts:87-89`）；`effortColor(level, palette)`
（`src/palette.ts:110-118`）在 level 合法时返回对应色，否则回退 `palette.effort.medium`
（`src/palette.ts:117`）；`truecolorFg(hex)`（`src/palette.ts:121-127`）把 hex 转成
`\x1b[38;2;r;g;bm` 前景序列，可被 `badge.parseTruecolor` 解析。

颜色本身只作为“前景色”传入段落，真正作为背景渲染由 2.3 的 `powerlineChain` 完成。

### 2.8 依赖关系（pi-core 与实际 import）

**statusline 源码对 pi-core 没有任何 import。** 逐个核对 `extensions/statusline/src/` 的 import：
只有三类——pi SDK（`@earendil-works/pi-coding-agent` 的类型、`@earendil-works/pi-tui` 的
`truncateToWidth`/`visibleWidth`）、Node 内建（`node:fs`/`node:os`/`node:path`）、以及本地包
`packages/shared-tool-presentation/src/badge.ts`（`src/palette.ts:37`、`src/status-mode.ts:1`）。
不存在任何 `pi-core` 字样的引用。

这一约束被测试固定：`tests/structure-invariants.test.ts` 名为 “statusline has zero static imports from
pi-core”，递归读取 `src/` 下所有 `.ts`，断言内容不含 `"pi-core"`（`tests/structure-invariants.test.ts:7-19`）。

因此需要注意两点与根 README 的表述差异：

- 根 `README.md` 称 `pi-core` “required by `pi-safety` and `statusline`”。就**代码依赖**而言，
  statusline 并不依赖 pi-core：它依赖的是 `packages/shared-tool-presentation`（包名
  `@crunl/shared-tool-presentation`，见其 `package.json`），而 pi-core 的
  `standalone.ts` 也 re-export 同一个包（`extensions/pi-core/standalone.ts:15-25`）。两者共享的是
  这个展示层包，不是 pi-core 本身。
- statusline 与 pi-core 之间确实存在**运行期/视觉**协作：editor 圆角盒与顶部 mode 徽章由 pi-core 的
  `registerEditorChrome`（`extensions/pi-core/src/register.ts:24`；定义于
  `extensions/pi-core/src/tui/editor-chrome.ts:135`，官方 `CustomEditor` 子类经
  `setEditorComponent` 安装，非 prototype patch）安装，pi-core 订阅 `pi-safety:mode` 总线事件
  （`extensions/pi-core/src/tui/editor-chrome.ts:139`）；statusline 只负责 footer。这是 README 所述的
  “editor chrome 由 pi-core 负责、本扩展只接管 footer”，属于扩展间约定而非 import 依赖。
- statusline 会读取别的扩展发布的状态：`pi-safety` 通过 `ctx.ui.setStatus("pi-safety", ...)` 发布
  （`extensions/pi-safety/src/register.ts:445`），statusline 用 `syncPermissionsMode` 把它从第二行里
  剔除（见 2.3）。

### 2.9 配置项

statusline 自身**没有扩展配置键**。可调项都来自外部：

- 全局/项目 `settings.outputPad`（仅影响 gutter 留白，见 2.6）。
- 环境变量 `PI_CODING_AGENT_DIR`（settings 目录）、`HOME` / `USERPROFILE`（用于把 cwd 缩成末级目录名）。
- 运行时开关 `/statusline`（`src/index.ts:57`），不持久化，进程内默认启用。

### 2.10 测试（`tests/`，5 个文件，25 个用例）

运行方式：`npm test`，即 `node --experimental-strip-types --test tests/*.test.ts`
（`extensions/statusline/package.json:5`）。覆盖范围：

| 文件 | 用例 | 覆盖对象 |
|---|---|---|
| `tests/palette.test.ts` | 8 | 双调色板具体色值、effort 与 fixed 不撞色、明暗检测、`effortColor` 回退、`truecolorFg` 可解析、`resolveModelInfo` 隐藏逻辑 |
| `tests/status-mode.test.ts` | 7 | `powerlineChain` 段数与帽、空输入、pi-safety 分区、`PermissionsModeState` 事件校验 |
| `tests/format.test.ts` | 5 | `formatCwd` 各分支、pi-lens 状态隐藏 |
| `tests/output-pad.test.ts` | 4 | `outputPad` 只认字面 0、项目覆盖优先、mtime 变化重读、项目 `.pi/` 布局 |
| `tests/structure-invariants.test.ts` | 1 | src/ 不含 `pi-core` 引用 |

**未覆盖的部分**：`src/footer.ts`（render 组装、左右对齐降级）、`src/usage.ts`
（`computeUsageTotals` 的条目遍历）、`src/index.ts`（事件接线与命令）都**没有测试引用**
（`tests/` 只 import `palette.ts` / `status-mode.ts` / `format.ts` / `output-pad.ts` / `model-info.ts`
以及共享包的 `badge.ts` / `permissions-mode.ts`）。仓库内没有已安装的 pi SDK（`node_modules/@earendil-works`
不存在），这些模块的集成行为未被自动验证。

---

## 三、tool-result-budget

单文件扩展（`extensions/tool-result-budget/index.ts`，180 行），无 `src/`、无测试。它限制**一个回合**内
经由工具结果进入上下文的字符总量，超出的部分整份写进 spill 文件，并在上下文里用“头 + 尾 + 指针”替换。
不编译、不加载任何跨包依赖。

### 3.1 动机（文件头注释，`index.ts:1-21`）

注释记录了作者本机的观测（302 个 session）：单请求上下文增长 p50 = 888、p90 = 4.4K、p99 = 15.4K、
max = 162.1K tokens（`index.ts:5`）。pi 的 compaction 触发条件是
`tokens > contextWindow - reserveTokens`（`index.ts:6-7`，注释引用
`dist/core/compaction/compaction.js:160`——该行号**已过期**，见第五节第 2 条），而它**只在回合之间**复查；
于是一批过大的工具输出可以一次性越过触发线，落进 max_tokens 截断
（注释写作 `available = window - est - 4096`，下限 1 → `"length"` + `output=1`；该公式在当前
pi 1.0.0 中**找不到对应实现**）并触发唯一的一次 overflow 恢复，之后报
“Context overflow recovery failed”（`index.ts:7-10`；该字符串真实存在，但在 `dist/core/agent-session.js:2349`
与 `:2525`，不在 compaction.js）。
本扩展不压缩、不中断、不触碰 pi 的 compaction 或 custom entries，因此与 `/goal` 续跑、pi-subagents、
goal 预算记账互不影响（`index.ts:12-14`）。**以上 pi 内部机制均已对照宿主全局安装的
pi 1.0.0 核实，结论是：触发条件与 overflow 字符串为真，但注释里的行号与截断公式已过期**
（见第五节第 2 条）。

### 3.2 预算与常量（`index.ts:27-36`）

| 常量 | 环境变量 | 默认 | 含义 |
|---|---|---|---|
| `TURN_BUDGET` | `PI_TOOL_TURN_BUDGET` | 60000 | 单回合经工具结果可进入上下文的字符数 |
| `MIN_KEEP` | `PI_TOOL_MIN_KEEP` | 4000 | 单个结果低于此值绝不缩减 |
| `SPILL_DIR` | `PI_TOOL_SPILL_DIR` | `join(getAgentDir(), "tool-spill")` | spill 文件目录 |
| `HEAD_RATIO` | — | 0.6 | 保留前缀占保留量的比例 |
| `LOG_FILE` | — | `getAgentDir()/logs/tool-result-budget.jsonl` | 运行日志 |

`num()`（`index.ts:27-30`）解析环境变量：非有限数或 `<= 0` 一律回退默认值（`index.ts:28-29`）。
`getAgentDir` 从 `@earendil-works/pi-coding-agent` 导入（`index.ts:25`），即 spill 与日志默认落在 pi 的
agent 目录下。

### 3.3 测量与判定流程（`pi.on("tool_result")`，`index.ts:117-179`）

每次工具结果返回时：

1. 取 `event.content`，非数组或空数组直接返回 `undefined`（`index.ts:119-120`）。
2. 只处理 `type === "text"` 的部分；没有文本部分就返回 `undefined`（`index.ts:123-124`）。
   图片等其他部分由 pi 另行限制（`index.ts:122` 注释）。
3. `totalChars` = 所有文本部分长度之和；为 0 则返回 `undefined`（`index.ts:126-130`）。
4. `remaining = Math.max(MIN_KEEP, TURN_BUDGET - spentThisTurn)`（`index.ts:133`），即剩余额度
   **永不低于 `MIN_KEEP`**。若 `totalChars <= remaining`，则累加 `spentThisTurn` 并原样返回
   `undefined`（不修改内容）（`index.ts:134-137`）。
5. 超预算时进入逐 part 循环（`index.ts:140-159`）：非文本部分原样保留；文本部分若
   `length <= allowance` 就扣减额度后原样保留；否则
   `keep = Math.max(MIN_KEEP, Math.min(allowance, text.length))`（`index.ts:154`），写 spill 文件后把该
   部分替换为 `clip(text, keep, toolName, path)`（`index.ts:155-156`），并扣减
   `allowance = Math.max(0, allowance - keep)`（`index.ts:157`）。
6. 若一个 part 都没被替换（`!spilled`），仍按原样累加并返回 `undefined`（`index.ts:160-163`）。
7. 发生替换时把 `spentThisTurn` 直接置为 `TURN_BUDGET`（`index.ts:165`）——**该回合后续工具结果将
   继续被缩减**，只有 `MIN_KEEP` 的兜底额度仍在起作用；随后写一条 `truncated` 日志并
   `return { content: next }`（`index.ts:166-177`）。
8. 整个处理包在 `try/catch` 内，任何异常都返回 `undefined`（`index.ts:178-179`）：**fail-open，
   永远保留原始结果**。

`spentThisTurn` 与 `turnSeq` 在 `pi.on("turn_start")`（`index.ts:108-111`）重置/自增，所以预算是
**按回合**而非按会话累计。

### 3.4 spill 文件（`spill()`，`index.ts:61-70`）

- 先 `mkdirSync(SPILL_DIR, { recursive: true })`（`index.ts:63`）。
- 文件名：`${ISO 时间戳replace(/[:.]/g,"-")}-${toolName}-${turnSeq}.txt`（`index.ts:64`），
  即时间戳 + 工具名 + 回合序号，天然避免覆盖。
- `writeFileSync(path, text)` 写入**完整**原文（`index.ts:66`），返回路径；失败则返回 `null`
  （`index.ts:69`）。写失败不会阻断流程——替换文本会改为提示“已丢弃”。

### 3.5 替换文本（`clip()`，`index.ts:73-92`）

保留量 `keep` 按 `HEAD_RATIO` 切分：`head = Math.floor(keep * 0.6)`、`tail = keep - head`
（`index.ts:79-80`）。统计被省略的中段：`omittedChars = text.length - keep`（`index.ts:81`）、
`omittedLines = text.slice(head, text.length - tail).split("\n").length`（`index.ts:82`）。

输出结构（`index.ts:89-92`）为 `头部 + 空行 + 横幅 + 空行 + 尾部`。横幅形如：

```text
[... <label>: <omittedChars> chars / ~<omittedLines> lines omitted from the middle of a <text.length>-char, <lines>-line result. <pointer> ...]
```

其中 `<label>` 是工具名。`pointer` 分两种（`index.ts:84-86`）：

- 成功落盘：`Full output spilled to: <path>`，并给出两条检索建议——`read <path> offset=200 limit=300`
  切片读、`grep -n "pattern" <path>` 搜索。
- spill 失败：`Full output was dropped (spill failed); re-run the command with a narrower scope if you need the middle.`

**指针如何让模型取回全文**：横幅里内嵌 spill 文件的绝对路径，模型可以按提示用 `read` 的
`offset`/`limit` 分片读，或用 `grep -n` 定位——这是唯一的检索通道，扩展本身不提供任何回读 API。

### 3.6 系统提示注入（`index.ts:42-47`、`index.ts:113-115`）

`DISCIPLINE` 字符串（`index.ts:42-47`）由**同一组常量**拼出，因此环境变量改预算时提示词不会与行为脱节
（`index.ts:39-41` 注释）。内容告知模型：每回合至多多少字符、低于多少不会被缩减、超出的全文在哪、
以及“需要省略的中段时用 `read`/`grep` 分片检索，不要盲目重跑命令，也不要基于被省略的中段下结论”。

注入方式：`pi.on("before_agent_start")` 中
`event.systemPromptOptions.sections.tool_result_budget = DISCIPLINE`（`index.ts:113-115`）——作为独立的
system-prompt section，不修改其他 section。

### 3.7 日志（`index.ts:52-59`）

`log()` 写 JSONL（best-effort，`mkdirSync` + `appendFileSync`，异常静默，`index.ts:53-58`）：

- 加载时一行 `loaded`：`{ts, event:"loaded", pid, budget, minKeep, spillDir}`（`index.ts:98-106`），
  用来从日志判断“本进程到底有没有加载这个扩展”；`pid` 可区分交互会话与 subagent 子进程。
- 截断时一行 `truncated`：`{ts, event:"truncated", pid, turn, tool, originalChars, budget}`
  （`index.ts:166-174`）。

### 3.8 与 compaction 的关系

要点是**节流而非补救**：pi 的 compaction 触发检查只发生在回合之间（3.1），因此只要单回合新增的
工具输出足够小，就不会一次越过触发线并掉进 max_tokens 截断。本扩展把“单回合可新增”钉在
`TURN_BUDGET`，从而让触发线仍然由 pi 自己在回合边界正常判定。它本身不做压缩，也不改变
contextWindow/reserveTokens 的任何值。

### 3.9 配置

只用环境变量（`index.ts:32-35`），无 settings 文件键：`PI_TOOL_TURN_BUDGET`、`PI_TOOL_MIN_KEEP`、
`PI_TOOL_SPILL_DIR`（见 3.2）。README 的表格与之一致（`extensions/tool-result-budget/README.md`）。
三方常量与注入的提示词同源，改预算后需重启 pi 进程生效（常量在模块加载时求值，`index.ts:32-36`）。

### 3.10 测试

**没有任何测试。** 该包没有 `tests/` 目录，`package.json` 也没有 `test`/`check` 脚本
（`extensions/tool-result-budget/package.json`；README 的 “Development” 一节明确写着
“No check/lint/test setup — one file, no dependencies”）。验证只能靠运行时观察 `loaded`/`truncated`
日志与结果文本。

---

## 四、安装

两个扩展都按本地路径安装（monorepo 不支持 git 子目录安装，也尚未发布 npm，见根 `README.md`）：

```bash
pi install ~/path/to/pi-ext-stuff/extensions/statusline
pi install ~/path/to/pi-ext-stuff/extensions/tool-result-budget
```

直接加载 `.ts` 源码，无构建步骤（两个包都是 `"type": "module"` 且不含编译产物）。
整个套件也可以由根 `package.json` 的 `pi.extensions` 数组一次性加载。

- statusline：装好后默认接管 footer；`/statusline` 可在自定义与内置 footer 之间切换；
  改动源码后 `/reload`。
- tool-result-budget：装好后自动生效，无命令；需要调参就改环境变量并重启 pi。
- 两个扩展都应只加载一次（符号链接 + settings 条目会重复加载，见根 README）。

---

## 五、未能验证的声明

以下项目我无法在本仓库内证实，已在正文中标注为“引自注释/README”：

1. **Latte rosewater → flamingo 相邻 ΔE = 4.3**（`src/palette.ts:14-15`）——**已复现，度量需标注**。
   实测 rosewater `#dc8a78` → flamingo `#dd7878`：CIE76 ≈ 11.7、CIEDE2000 ≈ 7.4，均非 4.3；
   但 **OKLab 欧氏距离 ×100 = 4.3212**，即 4.3。该度量出自已删除的研究文档
   `extensions/statusline/docs/light-palette-effort-research.md`（提交 `fa5e279` 可见），
   其中定义 “OKLab 欧氏距离 ×100（OKΔE）” 并给出相邻 effort 档 ≥6 的门槛；据此 4.3 低于门槛，
   注释中“等级变化会糊在一起”的理由成立（实际采用的 lavender → flamingo OKΔE ≈ 24.6）。
   注意 rosewater 并不在 `PALETTE_LIGHT` 中（它是被否决的备选色），故该数值无法只从色值表推出。
   `src/palette.ts` 的注释已补标度量名。

   **后续注记（提交 `880d6de` 起已取代）**：Light 整套调色板已同色相压深，lavender 本身也不再在 `PALETTE_LIGHT` 中（现 medium 为深宝石蓝 `#4564d5`）。以上 OKΔE 数值作为旧色对的测量仍然成立，但不再描述线上颜色；现行档位区分度由 `src/palette.ts` 头注释（CIE76）与 `tests/palette.test.ts` 的对比度回归测试钉住。
2. **pi 的 compaction 机制**：已对照宿主全局安装的 pi 1.0.0
   （`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`）逐项核实
   `tool-result-budget/index.ts:6-12` 注释里的四项断言，**两项为真、两项已过期**：
   - ✅ 触发条件 `tokens > contextWindow - reserveTokens` 为真：真实实现是
     `dist/core/compaction/compaction.js:173-177` 的
     `export function shouldCompact(contextTokens, contextWindow, settings)`，返回
     `contextTokens > contextWindow - settings.reserveTokens`（`:176`）。
   - ❌ 注释引用的 `compaction.js:160` **行号已过期**：该行实际是 `return estimate;`，与触发条件无关。
     正确行号是 `:176`（`settings.reserveTokens` 默认值在 `:55`）。
   - ✅ 字符串 “Context overflow recovery failed” 为真，但在
     `dist/core/agent-session.js:2349`（`"…failed after one compact-and-retry attempt…"`）与
     `:2525`（`` `…failed: ${message}` ``），**不在** compaction.js。
   - ❌ 截断公式 `available = window - est - 4096` **找不到对应实现**：在 pi 1.0.0 的整个 `dist/`
     下 grep `- 4096` 零命中。
   更正说明：本节此前写作「本仓库未安装 pi SDK，无法对照 pi 源码」。该说法**只对了一半**——
   仓库内 `node_modules/@earendil-works` 确实不存在，但宿主全局装着 pi 1.0.0，因此是**可以**对照的，
   上述结论即为对照所得。
3. **根 README “pi-core 被 statusline 依赖”的表述**：与代码不符。statusline 源码零处提到 `pi-core`，
   且 `tests/structure-invariants.test.ts` 主动断言这一点；两者共享的是
   `packages/shared-tool-presentation`。正文按代码纠正。
4. **`getAgentDir()` 的实际返回值**（是否等于 `~/.pi/agent`）：由 pi SDK 提供，仓库内无法确认；
   因此 `SPILL_DIR` 的默认绝对路径只能标为“代码所写的默认表达式”。
5. **终端最终视觉效果**：powerline 帽/箭头/图标的实际观感、Nerd Font 回退行为，无法在无 TUI 环境验证。
6. **`palette.ts:4-5` “cap contrast on pale backgrounds” 的具体测量出处**：仍无法核实。需要更正的是
   本文此前把这句话当成了“medium 选 lavender”的依据——它其实是解释**Light 档整体为何用 Latte
   而非 Frappé**（浅底上压低对比度），与 medium 的选色是两件事。medium 选 lavender 的依据是可核实的
   OKΔE 档距：lavender → flamingo ≈ 24.6、blue → lavender ≈ 12.3，而被否决的 rosewater → flamingo
   仅 ≈ 4.3（见第 1 条）。研究文档另给出 sapphire 被否的原因（与 folder teal 仅 ≈ 5.1，会撞色）。

   **后续注记（提交 `880d6de` 起已取代）**：以上 lavender/sapphire 选色讨论针对的是旧 Light 调色板，现行 `PALETTE_LIGHT` 已整体压深（medium 为 `#4564d5`），选色依据改为"同色相压深至双 ≥4.5"，见 `src/palette.ts` 头注释。本条作为历史核查记录保留。
