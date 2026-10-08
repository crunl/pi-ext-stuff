# pi-safety

> 中文说明 · English: [`README.md`](README.md)

为 pi coding agent 提供权限模式（`auto` / `yolo`），配合沙箱化工具执行，以及一个代你批准高风险动作的外部 guardian reviewer。以 `.ts` 源码形式分发——pi 直接加载扩展，因此**没有构建步骤**。

## 特性

- **权限模式** —— `auto` 让 guardian reviewer 代你批准高风险动作；`yolo` 不受限制地运行。（旧的人工弹窗 `default`/`plan` 模式已退役。）
- **沙箱化执行** —— `bash` / `write` / `edit` 运行在 OS 强制的沙箱内（默认 workspace-write）。公网访问在连接边界处自动接受评审。
- **Guardian reviewer** —— 一个外部 LLM 裁判，重新审查静态策略无法证明安全的一切。被拒动作可以用 `/approve` 精确重试一次。

## 一次工具调用如何流动

每个 `bash` / `write` / `edit` 调用都走同一条流水线。每一层只能*收窄*下一层所见——下游无法把它放宽。

```text
 你的工具调用
      │
 ① prepare ──────────── 激活 + 快照：哪个 mode、哪份 policy
      │
 ② static risk ──────── lexer → AST → segments：能证明它安全吗？
      │                  （无法证明 ≠ 危险；只是需要一个裁判）
 ③ engine admission ─── 这个调用形态本身可准入吗？
      │
 ④ guardian review ──── 外部 LLM 裁判批准 ② 无法证明的部分
      │
 ⑤ capability lease ─── sandboxed | escalated | unrestricted
      │
 ⑥ SRT sandbox ──────── 内核强制（seatbelt / bwrap）
      │
   命令真正开始运行
```

| 层 | 决定什么 | 失败形态 |
|---|---|---|
| ① prepare | mode、policy、snapshot | `stale-invocation` |
| ② static risk | 可证明安全 vs 需要评审 | `policy-denied` |
| ③ admission | 调用形态是否合法 | `policy-denied` |
| ④ guardian | 批准 / 拒绝 | `review-denied`，可经 `/approve` 重试 |
| ⑤ lease | 由哪个后端执行 | `enforcement-unavailable` |
| ⑥ SRT | **运行过程中**内核说行/不行 | 命令自身的错误，或超时 |

`yolo` 下 ②–⑥ 全部跳过（⑥ 也一样——不进沙箱）。Host-first 工具（`read`/`grep`/`find`/`ls`）只经过 ① 和一次 deny 规则检查；外部（MCP/自定义）工具一层都不经过。

**⑥ 是唯一在命令启动之后才起作用的一层。** 那里被拒看起来像命令自身失败——常常是挂住直到超时，而不是一个干净的报错。发生这种情况时 footer 会显示 `SRT diagnostic observations`，它们是*有界的、可能经过脱敏的，且永远不构成授权证据*。

沙箱 policy 本身并不由 ②–⑤ 产生：`createSandboxRuntimeConfig` 在激活时（session 启动、turn 启动、mode 切换）把 `safety.json` 的 `sandbox` 段直接投影成 policy。guardian 则在它自己独立的只读、零网络 policy 下运行。

完整讲解见 [`docs/pi-safety.md`](../../docs/pi-safety.md)。

## 安装

```bash
pi install ~/path/to/pi-ext-stuff/extensions/pi-safety
```

从 `packages/shared-tool-presentation` 取用呈现辅助函数（共享的 Codex 工具渲染面）。

## 配置 / 命令

运行时配置位于 `~/.pi/agent/safety.json`（或 `$PI_CODING_AGENT_DIR/safety.json`）。把 [`config.example.json`](config.example.json) 拷到那里，再按需裁剪——最小起点是 `sandbox.enabled: true` 配默认的 workspace-write profile 和空 `rules`。

- `/approve` —— 授权对最近一次 auto-review 拒绝的精确重试。
- `request_permissions` 工具 —— 请求一个 turn 范围的文件系统或网络授权，而不是盲目重试。

## 与其他扩展的关系

只从 `packages/shared-tool-presentation` 导入呈现辅助函数。在事件总线上发出 `pi-safety:mode`（还有 `:review`、`:delegation`），`statusline` 会监听它。

## 开发

```bash
npm run check && npm run lint && npm test
```

完整扩展讲解见 [`AGENTS.md`](AGENTS.md)（命令、产品边界、布局）和 [`docs/pi-safety.md`](../../docs/pi-safety.md)。

## 从 `pi-permissions` 迁移（2026 年 9 月更名）

下面所有路径都相对你的 agent 目录——设置了 `$PI_CODING_AGENT_DIR` 时为它，否则为 `~/.pi/agent`。先导出一次：

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
```

按此顺序做三处改动，中间不要启动新的 pi session（半更名状态会让 guardian 保护离线）：

1. 更新 settings 条目，让 pi 能定位到该包。如果你是通过 `pi install` 安装的，条目是 `$AGENT_DIR/settings.json` 里的一个路径：把 `extensions/pi-permissions` 这一段替换为 `extensions/pi-safety`。如果你是把包 symlink 进 `$AGENT_DIR/extensions/`，则把那个 symlink 重新指向新目录。不要同时保留两个条目——基于路径的去重会把包加载两次，重复的工具注册会冲突。
2. 移动配置文件（这是纯粹的扩展约定，host 对此一无所知）：
    ```bash
    mv "$AGENT_DIR/permissions.json" "$AGENT_DIR/safety.json"
    ```
    没有 legacy fallback：更名后扩展只读 `safety.json`，所以漏掉这步移动会静默回退到默认配置，你的 deny 规则和网络限制将全部失效。
3. 启动一个新的 pi session。旧 `pi-permissions-state` 名称下的权限模式状态是**故意**不迁移的——丢掉它是 fail-closed 的。如果你改过 mode，请重新设置。

`$AGENT_DIR/sessions/` 下的旧 session 日志仍会提到 `pi-permissions`；它们是审计痕迹，不会被改写。
