# statusline

pi 全局 TUI 状态行扩展：重排 footer，并将 token、模型和 effort 信息嵌入 editor 边框。

安装位置：

```text
~/.pi/agent/extensions/statusline/
```

## 当前布局

```text
[ 消息流 ... ]
──────────────────────────────── ↑284k ↓37.3k ──
 > 输入内容…
── Default•(provider) model•effort ─────────────
󰉋 ~/project 󰙁 main • session    CH66.4%   █████░░░░░ 80.6k/192k
[其他扩展的 setStatus 状态（有则显示）]
```

## 显示内容

### Editor 上边框

右侧显示当前 session 的累计 token：

```text
↑input ↓output
```

数字使用紧凑格式，例如 `284k`、`37.3k`、`1.5M`。

### Editor 下边框

左侧显示当前模型：

```text
Default•(provider) model•effort
```

- `Default`：`pi-permissions` 通过 `setStatus` 发布的当前 mode
- `provider`：当前 provider ID
- `model`：当前 model ID
- `effort`：当前 thinking level
- 非 reasoning 模型不显示 effort
- 边框继续使用 pi 原生的 thinking/bash mode 动态颜色
- 未加载 `pi-permissions` 时，降级为原来的 `(provider) model • effort`

### Footer 左侧

```text
󰉋 cwd 󰙁 branch • session-name
```

- `󰉋`：当前工作目录
- home 目录缩写为 `~`
- `󰙁`：当前 Git branch（存在时显示）
- session name 存在时追加显示

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

## 文件结构

```text
statusline/
├── index.ts              # pi 自动发现入口，仅转发 src/index.ts
├── src/
│   ├── index.ts          # 扩展实现入口、事件接线、安装/卸载
│   ├── model-editor.ts   # CustomEditor：上下边框嵌入状态信息
│   ├── footer.ts         # 自定义 footer、Nerd Font、context meter
│   ├── usage.ts          # 累加 session token/cache/cost usage
│   └── format.ts         # token 格式、对齐、cwd、icons、meter 工具
├── package.json          # ESM 模块配置
└── README.md
```

根目录 `index.ts` 保持符合 pi 的 `extensions/*/index.ts` 自动发现规则；实际实现统一放在 `src/`。

## 实现方式

- 使用 `ctx.ui.setEditorComponent()` 安装 `ModelLineEditor`
- `ModelLineEditor extends CustomEditor`，在 `super.render()` 后改写纯横线边框
- 使用 `ctx.ui.setFooter()` 替换内置 footer
- 使用 `footerData.onBranchChange()` 刷新 Git branch
- 将 `pi-permissions` 的 mode 移入 editor 下边框，避免 footer 重复显示
- 继续在 footer 渲染其他扩展通过 `ctx.ui.setStatus()` 设置的状态
- 实现模式参考 pi 官方 `examples/extensions/modal-editor.ts` 和 `custom-footer.ts`

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
