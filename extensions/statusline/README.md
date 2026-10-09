# statusline

pi 全局 TUI 状态行扩展：自定义 footer（powerline 链 + token/模型/effort 信息）。

安装：

```bash
pi install ~/path/to/pi-ext-stuff/extensions/statusline
```

## 当前布局

Editor 圆角盒与顶栏 mode 徽章由 `pi-core` 的 editor chrome 负责（本扩展无静态依赖）。
本扩展只接管 footer。

```text
[ 消息流 ... ]
╭──Auto──────────────────────────╮
│ 输入内容…                          │
╰──────────────────────────────────╯
modeleffortfolderbranch   CH66.4%  █████░░░░░ 80.6k/192k
[其他扩展的 setStatus 状态（有则显示）]
```

## 显示内容

### Footer 左侧（powerline 链）

```text
modeleffortfolderbranch
```

- 段色：Catppuccin 双主题 truecolor（dark=Frappe / light=Latte，按 `userMessageBg` 亮度切换）。dark：model=mauve，folder=sky，git=yellow；effort green→blue→rosewater→flamingo→peach→pink。light：model=mauve（不变），folder=深青，git=深赭；effort 取同色相压深版（深绿→深蓝→深宝石蓝→砖红→深橙红→深品红）。取色规则：色相即身份（跨主题、跨 pill/`|` 形态不变），明度做适配——light 端压到"前景 vs 底 ≥4.5 且白字 vs 块 ≥4.5"，故 light 全用白字 pill 文；dark 沿用粉彩端黑字。effort=off 时不显示。配色取舍见 `src/palette.ts` 文件头注释。

### Footer 右侧

```text
 CH66.4%   █████░░░░░ 80.6k/192k
```

- `CH66.4%`：最近一条 assistant message 的缓存命中率
- ``：context window 使用情况
- `█████░░░░░`：10 格 context usage meter
- `80.6k/192k`：当前 context tokens / model context window

> 块状 meter 表示 **context window 使用率**；`CHxx%` 表示缓存命中率，两者含义不同。

## Context meter 颜色

| Context 使用率 | 颜色 token |
|---|---|
| `< 50%` | `success` |
| `50%–74%` | `warning` |
| `≥ 75%` | `error` |

未填充的 `░` 使用 `dim`。

## Nerd Font

扩展使用以下 Nerd Font glyph：

| 含义 | Glyph |
|---|---|
| Directory | `󰉋` |
| Git branch | `󰙁` |
| Cache | `` |
| Context usage | `` |

终端需要使用 Nerd Font，否则图标可能显示为空白或方框。所有 glyph 在 pi-tui 的 `visibleWidth()` 中均按一列计算。

## 命令

```text
/statusline
```

在自定义 statusline 与 pi 内置 footer 之间切换（editor chrome 始终由 pi-core 提供）。扩展默认启用。

修改扩展后可执行：

```text
/reload
```

## 接线与组合

实现入口 `src/index.ts`（根 `index.ts` 仅转发，符合 pi 自动发现规则）。
- `ctx.ui.setFooter()`：实现自定义底部栏。
- 颜色直接读取公开的 `ctx.ui.theme`（完整 Theme）。
- editor chrome（圆角盒 + mode 徽章）由 `pi-core` 的 `registerEditorChrome` 统一安装（官方 `CustomEditor` 子类经 `setEditorComponent`，非 prototype patch）；权限状态通过 `pi-safety:mode` 总线事件解耦接收（pi-core 订阅）。

### 模块分层（宽度自适应）

宽度降级的全部逻辑是**纯函数、零 pi 依赖**，因此可在 bare `node --test` 下完整单测（无需 pi 运行时）：

- `src/footer.ts`：唯一接触 Pi 的薄壳。每帧从 `ctx` 采集数据（model/effort/folder/branch、cache 命中率、context usage、outputPad、statuses），注入 pi-tui 的 `visibleWidth`/`truncateToWidth` 与 `theme.fg`，然后调用 `renderFooterLines`。
- `src/degrade.ts`：降级阶梯与整帧渲染（`buildLeftForms` / `buildRightForms` / `buildFooterCandidates` / `renderFooterLines`）。`measure`/`truncate`/`fg` 均为注入参数。
- `src/layout.ts`：`Span`（自带实测可见宽度的字符串）原语 + `selectFitting` 选级 + `dedupeNarrowing`。`Span` 消灭了旧的 plain/colored 双轨——宽度只在构造时测一次，之后 `paint`/`join` 只做加法，着色版本永不与宽度漂移。

## 当前降级行为

宽度不足时，footer 沿一条**全局牺牲阶梯**逐级降级（`src/degrade.ts` 的 `SHED_MOVES`）。每级都比上一级更窄、信息更少，所以「保留内容」关于可用宽度单调不减，不会逐帧闪烁。右侧按稀缺性先降，左侧随后。

右侧（context 遥测）阶梯：

```text
CH66%  █████░░░░░ 80.6k/192k   全量
       █████░░░░░ 80.6k/192k   丢 CH（过去时、无阈值、不可行动，最先牺牲）
       ███░░ 80.6k/192k        meter 10 格 → 5 格（唯一可压缩的编码，充当缓冲）
       80.6k/192k              丢 meter（纯冗余通道，颜色已搬到数字上）
       42%                     tokens → 百分比（pi 自动压缩按百分比判定）
       （阈值染色 icon）        兜底：1 列仍表达 ok/warn/compact
                               右侧全空
```

左侧（定位信息）阶梯：powerline pill（带 icon / 圆角帽）→ 纯文本 `|` 分隔（弃 icon 与 pill 包裹，保留全部名称）→ 依次丢 branch / effort / folder → 仅剩 model。

- **pill 永不被字符级截断**：字符级截断会砍掉右帽 `\uE0B4`、留下开口色块。因此左侧先整体降级为 `|` 分隔的纯文本，只有在**唯一存活段**内部才允许 `truncateToWidth`。
- 右侧为空时**不会**触发左侧截断（显式短路 `minPadding`）。
- 每一级宽度都用实测 `visibleWidth()` 判定，不靠公式估算（`formatTokens` 在 99999→100000 处宽度非单调）。
- 第 2 行（其他扩展 `setStatus`）与第 1 行独立满足同一宽度红线；拼接前把 `\t`/换行折成空格并折叠连续空格（第三方 status 带 tab 是唯一的溢出崩溃路径）。
- `usage.percent` 为 `null`（compaction 后、中断后）时渲染 `?` 并用 `dim`，**不会**误染成绿色 success。

## 已知限制

- footer usage 按 `sessionId + leafId + model` 脏键缓存（`src/usage.ts` 的 `createUsageCache`）：流式 chunk 只命中缓存（零遍历），仅 session/leaf/model 变化时全量重算一次。正确性依赖宿主 append-only 不变量（每次 append 前进 `leafId`，resume/fork 换 `sessionId`）；键不可读时 fail-open 全量重算
- provider 始终显示，不区分单 provider 和多 provider
- 未显示内置 footer 的 `(auto)` 自动压缩标记
- Nerd Font glyph 的最终视觉效果取决于终端字体和 fallback 配置
