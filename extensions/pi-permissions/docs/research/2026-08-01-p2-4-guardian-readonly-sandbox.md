# P2-4 Guardian read-only sandbox parity research

日期：2026-08-01

本次核对使用 `gh api repos/openai/codex/commits/main` 确认 upstream
`openai/codex` 当前 `main` 为
`ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff`（`Extract exec-server request
dispatching (#36440)`）。本地 checkout `/private/tmp/codex-current` 与该
提交一致。

## 结论

P2-4 的目标不是把 Guardian 收紧为 workspace-only。Codex Guardian 的
`PermissionProfile::read_only()` 是“sandbox 可见范围内的全盘只读”：

- Guardian session 将 `approval_policy` 固定为 `Never`；
- 将 `PermissionProfile` 固定为 `read_only()`；
- 清空 MCP servers，并关闭 Apps、Plugins、Hooks、Web Search、Collab 和
  Multi-Agent 等非必要能力；
- 不继承 parent turn 的 exec-policy；
- `read_only()` 使用 `Root + Read`，所以 cwd 外的绝对路径仍可读取；
- parent turn 的 `deny-read` 是 Guardian 判断待批准 action 时看到的政策上下文，
  不是简单复制为 child read tool 的 deny list；
- 写入/删除由 read-only profile 和平台 sandbox 拒绝，网络默认受限。

对应源码：

- Codex [guardian/review_session.rs](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/core/src/guardian/review_session.rs#L798-L835)
  设置 child turn 的 read-only profile；
- [guardian/review_session.rs](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/core/src/guardian/review_session.rs#L1001-L1082)
  固定 session 配置、清空 MCP 并关闭非必要 feature；
- [protocol/models.rs](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/protocol/src/models.rs#L375-L383)
  与 [protocol/permissions.rs](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/protocol/src/permissions.rs#L388-L406)
  定义 `read_only()`；
- [session/mod.rs](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/core/src/session/mod.rs#L567-L572)
  为 Guardian 使用新的空 exec-policy。

## Pi 当前行为与 API 边界

当前 `src/guardian-tools.ts:55-87` 从
`createReadOnlyTools(cwd)` 过滤出 `read`、`grep`、`find`、`ls`，然后直接调用
原始 AgentTool 的 `execute()`。这保留了 cwd 外绝对路径读取，但没有把执行交给
`SandboxManager`，也没有独立的 child read-only sandbox。

已安装的 `@earendil-works/pi-coding-agent@0.82.1` 提供的公开 API 不是完全对称的：

| Pi tool | 可注入 API | P2-4 风险/含义 |
|---|---|---|
| `read` | `ReadOperations.readFile/access` | 可以接到 sandboxed read-only file runner；不能直接复用当前 `createSandboxedFileOperations` 的 `access`，因为它检查 `R_OK | W_OK`。 |
| `ls` | `LsOperations.exists/stat/readdir` | 可以接到 sandboxed directory runner。 |
| `grep` | 只有 `GrepOperations.isDirectory/readFile` | Pi tool 内部仍会 `ensureTool("rg")`，随后直接 `spawn(rgPath, ...)`；没有 process executor 注入点。 |
| `find` | `FindOperations.exists/glob` | 提供自定义 `glob` 时可以绕过内部 `fd` 分支；默认路径会 `ensureTool("fd")`，可能下载并写缓存。 |

直接证据：

- `createReadOnlyTools(cwd, options?)` 与四种 operations 类型在本地
  `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.d.ts`
  及 `read.d.ts`、`grep.d.ts`、`find.d.ts`、`ls.d.ts`；
- `grep.js:93-145` 在使用自定义 operations 前调用 `ensureTool("rg", true)`，
  并直接 spawn `rg`；
- `find.js:97-196` 只有自定义 `glob` 才绕过 `ensureTool("fd", true)`；
- `utils/tools-manager.js:95-120, 287+` 在工具不存在时访问 GitHub release 并写入
  Pi 工具缓存。

因此，简单地把 `createReadOnlyTools(cwd)` 放入 Guardian 并不能声称与 Codex
read-only sandbox 对齐：在当前机器上 `rg` 存在，但 `fd` 不存在，Guardian 调用
`find` 会触发 Pi Agent 的自动下载路径。该路径本身具有网络和写入副作用。

## Sandbox 生命周期核对

Pi 的 `SandboxManager` 是进程级 singleton，但
`SandboxManager.wrapWithSandbox(command, ..., customConfig)` 支持每次调用传入
custom config；它不要求 Guardian 为了读取而 `reset()` 或 `initialize()`。相反，
Guardian 如果重置共享 manager，会与 parent tool execution 的 sandbox 状态互相覆盖。

当前 `src/sandbox.ts` 已有的 `createSandboxedFileOperations()` 主要服务 write/edit：
它允许额外 write roots，且 `access` 检查可写权限，不能原样作为 Guardian 的
read-only operations。P2-4 需要新增只读 runner，而不是修改 write/edit runner 的
语义。

## 推荐实施边界

1. 新增固定的 Guardian child sandbox config：`allowWrite=[]`、`denyRead=[]`、
   网络 allowlist 为空。`denyRead=[]` 是有意的：parent deny-read 继续留在
   Guardian prompt/context 中，但不收紧 child 自身的全盘只读读取能力。
2. 通过 Pi Agent 公开的 `read`/`ls` operations API，把文件和目录读取交给
   `SandboxManager.wrapWithSandbox()` 生成的子进程执行；读操作不得调用
   `reset()`/`initialize()`。
3. 对 `grep`/`find` 使用不会自动下载的 sandboxed command adapter：
   - `find` 使用自定义 `glob`，不走 Pi Agent 的 `fd` auto-download 分支；
   - `grep` 不直接调用 Pi Agent 内置的 `ensureTool("rg")` 路径，而使用固定参数、
     shell-quoted 的 `rg` sandboxed runner；缺失依赖时返回只读 tool error，不联网下载；
   - 只保留搜索所需的输出/截断语义，不复制 Pi UI renderer。
4. 由 `register.ts` 把现有 `sandboxManager` 注入默认 `PiAutoReviewer` 的
   Guardian tool factory。测试注入的 `autoReviewer` 和现有的 fake tool factory
   继续可用。
5. sandbox runner 失败、工具依赖不可用或 tool call 非 allowlist 时保持当前
   fail-closed 行为；禁止回退到未 sandbox 的 direct filesystem tool。

## 不应做的事

- 不添加 cwd/workspace containment；那会比 Codex 更严格；
- 不把 `filesystemDenyRead` 直接复制为 Guardian child deny-read；
- 不为 Guardian 重置/重新初始化全局 `SandboxManager`；
- 不开放 `bash`、`write`、`edit`、MCP、network 或 nested approval 工具；
- 不通过修改 `node_modules` 或全局 `PI_OFFLINE` 环境变量来掩盖 Pi Agent API
  的 auto-download 行为。

## 尚未解决但明确隔离的差异

Codex Guardian 使用普通 Codex tool runtime，包含受 read-only profile 约束的 shell；
Pi 当前 Guardian 使用显式的本地 read-only 工具集合。这是 host/runtime API 差异，
不是 P2-4 为 Pi 增加 workspace-only 限制的理由。P2-4 只对齐“Guardian 不产生
写入/下载副作用、可在 sandbox 可见范围读取、网络默认受限”的有效权限边界；不复制
Codex 完整 child-session、telemetry 或 app-server 生命周期。

