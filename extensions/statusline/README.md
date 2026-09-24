# statusline

pi 全局 TUI 状态行扩展：重排 footer，并将 token、模型和 effort 信息嵌入 boxed editor 边框。

安装：

```bash
pi install ~/path/to/pi-ext-stuff/extensions/statusline
```

## 当前布局

Editor 为圆角盒（宽 ≥24）；mode 为 powerline 半圆胶囊，嵌在顶栏圆角之后。窄宽度退回无盒上下边框。

```text
[ 消息流 ... ]
╭──Auto─────────────────── ↑284k ↓37.3k ─╮
│ 输入内容…                               │
╰─────────────────────────────────────────╯
modeleffortfolderbranch   CH66.4%  █████░░░░░ 80.6k/192k
[其他扩展的 setStatus 状态（有则显示）]
```

## 显示内容

### Editor 上边框

左侧 mode 徽章（powerline 半圆胶囊）；右侧显示当前 session 的累计 token：

```text
↑input ↓output
```

数字使用紧凑格式，例如 `284k`、`37.3k`、`1.5M`。

### Editor 下边框

`SHOW_MODEL_ON_BORDER`（`model-editor.ts`）为 **false**（默认）时是纯横线，model/effort 只在 footer。设为 true 可把 powerline 胶囊放回下栏。

### Footer 左侧（powerline 链）

```text
modeleffortfolderbranch
```

- 段色：Catppuccin 双主题 truecolor（dark=Frappe / light=Latte，按 `userMessageBg` 亮度切换）。dark：model=mauve，folder=sky，git=yellow；effort green→blue→rosewater→flamingo→peach→pink。light：model=mauve，folder=teal，git=yellow；effort green→blue→lavender→flamingo→peach→pink。effort=off 时不显示。见 `docs/dark-palette-effort-research.md` / `docs/light-palette-effort-research.md`。
- `SHOW_MODEL_ON_BORDER`（`model-editor.ts`）为 false 时 editor 下栏是纯横线，model/effort 只在 footer

### Footer 右侧

```text
 CH66.4%   █████░░░░░ 80.6k/192k
```

- ` CH66.4%`：最近一条 assistant message 的缓存命中率
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

在自定义 statusline 与 pi 内置 footer/editor 之间切换。扩展默认启用。

修改扩展后可执行：

```text
/reload
```

## 开发

实现入口 `src/index.ts`（根 `index.ts` 仅转发，符合 pi 自动发现规则）；
`model-editor.ts`（boxed chrome）/ `box-editor.ts`（纯函数）/ `footer.ts` /
`usage.ts` / `format.ts` 各司其职。接线方式：`ctx.ui.setEditorComponent()` +
`ctx.ui.setFooter()`，参考 pi 官方 `modal-editor.ts` / `custom-footer.ts`
示例；并把 `pi-safety` 的 mode 移入 editor 下边框。

## 当前降级行为

- editor label 放不下时，保留原始纯横线边框
- editor 出现 `─── ↑/↓ N more ───` 滚动提示时，不覆盖滚动信息
- footer 左右内容同时放不下时，优先保留并截断左侧；右侧统计整体隐藏
- 没有 cache usage 时不显示 `CHxx%`
- 没有 context usage 时不显示 context meter

## 已知限制

- 当前每次 editor/footer render 都可能重新遍历 session entries 计算 usage；长会话需要后续增加事件驱动缓存
- footer 尚未实现宽度分级降级（10 格 → 5 格 → 仅 tokens）
- provider 始终显示，不区分单 provider 和多 provider
- 未显示内置 footer 的 `(auto)` 自动压缩标记
- 其他扩展若也调用 `setEditorComponent()`，后安装者会覆盖先安装者
- Nerd Font glyph 的最终视觉效果取决于终端字体和 fallback 配置
