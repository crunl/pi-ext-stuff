# statusline

本文覆盖 monorepo 中的 `extensions/statusline/`（pi 全局 TUI 状态行）：接管底部
footer，渲染 Catppuccin powerline 链加右侧 token 与缓存统计。全部结论均来自当前源码，
关键位置附 `路径:行号`。

## 一、总览

| | statusline |
|---|---|
| 入口 | `extensions/statusline/index.ts`（转发到 `src/index.ts`） |
| 源码 | `src/` 下 11 个文件，共 1159 行 |
| 测试 | `tests/` 7 个文件，49 个用例 |
| 依赖 | pi SDK + `packages/shared-tool-presentation` + Node 内建 |
| 配置 | 无扩展配置键；读取全局/项目 `settings.outputPad` |
| 作用时机 | 每帧 footer render |

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

### 2.2 Footer 组成与段落顺序（`src/footer.ts`，148 行）

`installFooter`（`src/footer.ts:39`）通过 `ctx.ui.setFooter((tui, theme, footerData) => {...})`
（`src/footer.ts:51`）注册一个 footer 组件对象，其 `render(width)` 返回字符串行数组。

左侧 powerline 链按固定顺序拼装（`src/footer.ts:64-100`）：

1. **model**：`ICONS.model ${model.modelId}`，前景色 `pal.fixed.model`（`src/footer.ts:71-78`）。
2. **effort**：仅当 `model.effort` 有值时加入，文本 `ICONS.effort ${model.effort}`，颜色
   `effortColor(model.effort, pal)`（`src/footer.ts:79-86`）。
3. **folder**：`ICONS.folder ${pwd}`，`pal.fixed.folder`（`src/footer.ts:87-92`）。`pwd` 来自
   `formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE)`
   （`src/footer.ts:87-89`），只展示末级目录名。
4. **branch**：仅当 `footerData.getGitBranch()` 非空时加入（`src/footer.ts:64`、`src/footer.ts:93-100`）。

分支变化通过 `footerData.onBranchChange(() => tui.requestRender())` 触发重绘，其返回值作为组件的
`dispose`（`src/footer.ts:52-60`）。

右侧统计按顺序拼接，用两个空格分隔（`src/degrade.ts:181-227`）：

- **`CHxx.x%`**：最近一条 assistant message 的缓存命中率，文本 `CH${latestCacheHitRate.toFixed(1)}%`
  （`src/degrade.ts:184-192`）。仅在 `(cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined`
  时显示（数据在 `src/footer.ts:103-117` 聚合）。
- **context meter**：`ctx.getContextUsage()`（数据在 `src/footer.ts:119-128`）非空时显示
  `ICONS.gauge ██░░░░░░░░ tokens/window`（`src/degrade.ts:194-218`）。
  - meter 格数由 `View.meter` 控制：完整视图 10 格，紧凑视图 5 格，关闭时不渲染
    （`src/degrade.ts:35-45`、`src/degrade.ts:123-178`）。
  - 颜色阈值（`src/degrade.ts:197-198`）：`pctValue >= 75` → `error`；`>= 50` → `warning`；否则 `success`。
    未填充的 `░` 固定用 `dim`（`src/degrade.ts:173-177`）。
  - token 文本：`usage.tokens !== null` 时为 `${formatTokens(usage.tokens)}/${formatTokens(usage.window)}`，
    否则 `?/${formatTokens(usage.window)}`（`src/degrade.ts:206-216`）。

**第二行**（可选）：仅当有其他扩展的状态时追加（`src/degrade.ts:296-305`）。状态来自
`footerData.getExtensionStatuses()`（`src/footer.ts:137`），先经 `syncPermissionsMode(...)` 过滤
（`src/degrade.ts:296`），再按 `isHiddenExtensionStatus(key)` 二次过滤，按 key 字典序排序、把内嵌换行压成空格
后拼接（`src/degrade.ts:296-303`）。

**宽度与 gutter**：

- gutter 宽度来自 `getOutputPad(ctx.cwd, ctx.isProjectTrusted())`（`src/footer.ts:129`），
  `innerWidth = Math.max(0, width - pad * 2)`（`src/degrade.ts:283`）。
- 左右组合由 `renderFooterLines` 完成：`buildCandidates` 根据 `View`/`SHED` 生成候选，`selectFitting` 选择最丰富的可用候选；仍放不下时只截断最瘦的左侧文本，右侧统计不会被字符级截断。

### 2.3 powerline 渲染（`src/powerline.ts`）

`powerlineChain(segments)` 把段落串成一颗 powerline 药丸。`PowerlineSegment` 直接携带
`Rgb` 三元组，不再经过 hex → ANSI → RGB 的往返：

- 相邻段落的分隔箭头为 U+E0B0；首尾帽为 `PL_LEFT` = U+E0B6、`PL_RIGHT` = U+E0B4，均从
  `packages/shared-tool-presentation/src/badge.ts` 导入。
- 每个 body 末尾补一个空格，第 2 段起在箭头后补一个前导空格，首段左侧贴紧。
- 帽用段落色作前景，正文用段落色作背景；文字颜色由 `contrastTextFor(rgb)` 按亮度选黑或白。
- 无颜色时保留原有退化行为：body 使用反显，帽和分隔箭头输出裸 glyph。

`src/status-mode.ts` 只保留 `partitionExtensionStatuses` / `syncPermissionsMode`，负责把
`pi-safety` 状态从 footer 第二行移除；权限状态由 pi-core 的 editor chrome 徽章呈现。

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
（数据在 `src/footer.ts:103-117` 聚合，最终由 `src/degrade.ts:184-192` 渲染）；`input` 与 `output` 被累加但从未显示。

`src/format.ts` 的纯函数：

- `formatTokens`（`src/format.ts:10-23`）：`999 → "999"`，`12300 → "12.3k"`，`1500000 → "1.5M"`；
  数值 ≥100 时省略小数。
- `formatCwd`（`src/format.ts:39-45`）：恰好等于 home 时返回 `"~"`，否则取路径末段；根目录 `/` 仍是 `/`。
- `meterCells`（`src/format.ts:73-76`）：`ceil(percent/100 * cells)`，先把 percent 夹到 0–100。
- `stripAnsi`（`src/format.ts:5-7`）：去掉 SGR 序列，供 `visibleWidth` 前测量代码点宽度。
- `ICONS`（`src/format.ts:48-56`）为 Nerd Font 码点：folder U+F024B、branch U+F0641、gauge U+F49B、
  cache U+F1C0、model U+F035B、effort U+F09D1。
- `HIDDEN_STATUS_KEYS = new Set(["pi-lens-lsp"])`（`src/format.ts:63`），`isHiddenExtensionStatus`
  （`src/format.ts:65-67`）按 key 匹配——pi-lens 每回合都会发布 LSP 状态，footer 丢弃它以保持单行。

### 2.6 output padding 同步（`src/output-pad.ts`，94 行）

footer 需要与聊天消息保持相同的左右留白，而 pi 的 footer API 不暴露 `outputPad`，因此本模块直接读
settings 文件：

- 路径：`agentDir()` = `PI_CODING_AGENT_DIR ?? ~/.pi/agent`（`src/output-pad.ts:21-23`），全局文件
  `<agentDir>/settings.json`，项目文件 `<cwd>/.pi/settings.json`（仅当项目被信任时）（`src/output-pad.ts:62-64`）。
- `readOutputPadFile`（`src/output-pad.ts:34-45`）：只有字面量 `0` 解析为 `0`，其余任何值（含缺失、解析失败）
  都是 `1`（`src/output-pad.ts:40`）。
- `effectiveOutputPad`（`src/output-pad.ts:47-52`）：项目键存在时优先，否则回退全局；最终仍按
  “`=== 0 ? 0 : 1`”归一（`src/output-pad.ts:51`）。
- `getOutputPad`（`src/output-pad.ts:64-88`）带 mtime 缓存：两个文件的 mtime 与缓存一致就直接返回，
  否则重读。这样 `/settings` 写入后下一帧即生效，无需 watch 定时器。
- `resetOutputPadCache`（`src/output-pad.ts:92-94`）是测试用的清缓存接口。

### 2.7 调色板系统（`src/palette.ts`，111 行）

双主题 Catppuccin，按终端明暗选择：

- `PALETTE_DARK` = Frappé（`src/palette.ts:52-66`，注释称对应 live theme `catppuccin-frappe`）。
  - fixed：model `#ca9ee6`（mauve）、folder `#99d1db`（sky）、git `#e5c890`（yellow）。
  - effort：minimal `#a6d189`（green）→ low `#8caaee`（blue）→ medium `#f2d5cf`（rosewater）→
    high `#eebebe`（flamingo）→ xhigh `#ef9f76`（peach）→ max `#f4b8e4`（pink）。
- `PALETTE_LIGHT` = Latte（`src/palette.ts:69-83`；提交 `880d6de` 起同色相压深，见下）。
  - fixed：model `#8839ef`（mauve，不变）→ folder `#00787f`（深青）→ git `#a25c00`（深赭）。
  - effort：minimal `#148002`（深绿）→ low `#0761ef`（深蓝）→ medium `#4564d5`（深宝石蓝）→
    high `#ae4f51`（砖红）→ xhigh `#ca3700`（深橙红）→ max `#b03f95`（深品红）。

  压深的理由（`src/palette.ts:11-31`）：Latte accent 本是前景色，直接做 pill 底在浅底上对比度
  不足（旧 git 黄块 vs 底仅 2.31、白字 vs 旧 teal/green 仅 3.74/3.34）。故 Light 每档沿色相压深，
  直至同时满足"前景 vs 底 ≥4.5 且白字 vs 块 ≥4.5"；压深后 YIQ 全 <128，白字是既有
  `contrastTextFor` 规则的自然输出，无需改规则。model `#8839ef` 本已达标故不动。
  此前的 rosewater/lavender 选色分析见第四节第 1、4 条的后续注记（已被本轮取代）。
- `EffortLevel` 类型为 `"minimal" | "low" | "medium" | "high" | "xhigh" | "max"`（`src/palette.ts:38-44`）。

明暗检测（`isLightThemeFrom`，`src/palette.ts:91-95`）：

- 直接读 live theme 的 `appearance`（pi ≥ 1.0 的 `Theme` getter：优先取主题 JSON 声明的值，
  否则由 pi 按主题颜色检测），`theme?.appearance === "light"` 即亮色，其余（含 `theme` 缺失、
  旧版 pi 无该字段）按 dark 处理。`src/footer.ts` 的 `FooterTheme` 为此声明了 `appearance` 字段。
- 旧实现读 `userMessageBg` 背景 ANSI 并以 YIQ 亮度 ≥128 判定；已被 `appearance` 取代。

其余导出：`paletteForLight(isLight)`（`src/palette.ts:87-89`）；`effortColor(level, palette)`
（`src/palette.ts:97-105`）在 level 合法时返回对应色，否则回退 `palette.effort.medium`
（`src/palette.ts:102`）；`hexToRgb(hex)`（`src/palette.ts:108-111`）把调色板 hex 转成
`Rgb` 三元组，供 `powerline.ts` 直接生成 SGR。

颜色本身只作为 `Rgb` 传入 powerline 段落，真正作为背景渲染由 2.3 的 `powerlineChain` 完成。

### 2.8 依赖关系（pi-core 与实际 import）

**statusline 源码对 pi-core 没有任何 import。** 逐个核对 `extensions/statusline/src/` 的 import：
只有三类——pi SDK（`@earendil-works/pi-coding-agent` 的类型、`@earendil-works/pi-tui` 的
`truncateToWidth`/`visibleWidth`）、Node 内建（`node:fs`/`node:os`/`node:path`）、以及本地包
`packages/shared-tool-presentation/src/badge.ts`（`src/powerline.ts:1`）。
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

### 2.10 测试（`tests/`，7 个文件，49 个用例）

运行方式：`npm test`，即 `node --experimental-strip-types --test tests/*.test.ts`
（`extensions/statusline/package.json:5`）。覆盖范围：

| 文件 | 用例 | 覆盖对象 |
|---|---|---|
| `tests/degrade.test.ts` | 16 | 声明式 shed 计划、候选宽度单调性、极窄宽度、状态行和渲染红线 |
| `tests/palette.test.ts` | 10 | 双调色板具体色值、RGB 转换、effort 与 fixed 不撞色、明暗检测、`effortColor` 回退、对比度、`resolveModelInfo` 隐藏逻辑 |
| `tests/status-mode.test.ts` | 7 | pi-safety 分区、`PermissionsModeState` 事件校验 |
| `tests/format.test.ts` | 5 | `formatCwd` 各分支、pi-lens 状态隐藏 |
| `tests/output-pad.test.ts` | 4 | `outputPad` 只认字面 0、项目覆盖优先、mtime 变化重读、项目 `.pi/` 布局 |
| `tests/usage-cache.test.ts` | 6 | usage 聚合、脏键缓存和 fail-open 刷新 |
| `tests/structure-invariants.test.ts` | 1 | src/ 不含 `pi-core` 引用 |

**未覆盖的部分**：`src/footer.ts`（render 组装、左右对齐降级）、`src/usage.ts`
（`computeUsageTotals` 的条目遍历）、`src/index.ts`（事件接线与命令）都**没有测试引用**
（`tests/` 只 import `palette.ts` / `status-mode.ts` / `format.ts` / `output-pad.ts` / `model-info.ts`
以及共享包的 `badge.ts` / `permissions-mode.ts`）。仓库内没有已安装的 pi SDK（`node_modules/@earendil-works`
不存在），这些模块的集成行为未被自动验证。

## 三、安装

按本地路径安装（monorepo 不支持 git 子目录安装，也尚未发布 npm，见根 `README.md`）：

```bash
pi install ~/path/to/pi-ext-stuff/extensions/statusline
```

直接加载 `.ts` 源码，无构建步骤（`"type": "module"` 且不含编译产物）。
也可以由根 `package.json` 的 `pi.extensions` 数组一次性加载。

- 装好后默认接管 footer；`/statusline` 可在自定义与内置 footer 之间切换；
  改动源码后 `/reload`。
- 应只加载一次（符号链接 + settings 条目会重复加载，见根 README）。

---

## 四、未能验证的声明

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
2. **根 README “pi-core 被 statusline 依赖”的表述**：与代码不符。statusline 源码零处提到 `pi-core`，
   且 `tests/structure-invariants.test.ts` 主动断言这一点；两者共享的是
   `packages/shared-tool-presentation`。正文按代码纠正。
3. **终端最终视觉效果**：powerline 帽/箭头/图标的实际观感、Nerd Font 回退行为，无法在无 TUI 环境验证。
4. **`palette.ts:4-5` “cap contrast on pale backgrounds” 的具体测量出处**：仍无法核实。需要更正的是
   本文此前把这句话当成了“medium 选 lavender”的依据——它其实是解释**Light 档整体为何用 Latte
   而非 Frappé**（浅底上压低对比度），与 medium 的选色是两件事。medium 选 lavender 的依据是可核实的
   OKΔE 档距：lavender → flamingo ≈ 24.6、blue → lavender ≈ 12.3，而被否决的 rosewater → flamingo
   仅 ≈ 4.3（见第 1 条）。研究文档另给出 sapphire 被否的原因（与 folder teal 仅 ≈ 5.1，会撞色）。

   **后续注记（提交 `880d6de` 起已取代）**：以上 lavender/sapphire 选色讨论针对的是旧 Light 调色板，现行 `PALETTE_LIGHT` 已整体压深（medium 为 `#4564d5`），选色依据改为"同色相压深至双 ≥4.5"，见 `src/palette.ts` 头注释。本条作为历史核查记录保留。
