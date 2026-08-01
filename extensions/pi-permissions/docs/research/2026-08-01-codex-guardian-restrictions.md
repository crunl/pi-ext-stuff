# Codex Guardian review sandbox 路径限制研究

日期：2026-08-01

本次只读核对使用 `gh api` 获取了：

- pinned commit [`789c72dcf62d7439863d4d2846454f05b3d51db6`](https://github.com/openai/codex/commit/789c72dcf62d7439863d4d2846454f05b3d51db6)
- 当前 `main`：[`ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff`](https://github.com/openai/codex/commit/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff)

## 结论摘要

Codex Guardian 的 `read-only` 不是“只能读 workspace”。它使用 `PermissionProfile::read_only()`：文件系统策略是受 sandbox 管理的全盘只读（`Root + Read`），网络默认受限；实际写入/读取边界由 macOS Seatbelt、Linux sandbox 或 Windows restricted-token 强制执行。

当前 `main` 与 pinned commit 在 Guardian sandbox、权限 profile、路径规范化和相关工具注册上的行为没有实质差异。两者差异仅出现在后续测试结构字段等非路径限制内容；例如 [pinned review_session.rs](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/review_session.rs#L1001-L1082) 与 [main review_session.rs](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/core/src/guardian/review_session.rs#L1001-L1082) 的限制逻辑一致。

## Codex Guardian 的实际权限边界

### 1. Guardian session 使用全盘只读 profile

Guardian session 配置会：

- 将 `approval_policy` 固定为 `Never`；
- 将 `PermissionProfile` 固定为 `read_only()`；
- 清空 MCP servers；
- 关闭 Apps、Plugins、Hooks、Web Search、Collab 和 Multi-Agent 等非必要能力；
- 不继承 parent turn 的 exec-policy。

证据：[review_session.rs:1001-1082](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/review_session.rs#L1001-L1082)。

`PermissionProfile::read_only()` 被定义为受管理的 `FileSystemSandboxPolicy::read_only()`，而该策略只有根路径的 `Read` entry；`has_full_disk_read_access()` 对这种策略返回 true。因此 Guardian 的读取范围不是 cwd 或 workspace roots，而是 sandbox 可见的整个文件系统。

证据：[models.rs:301-383](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/protocol/src/models.rs#L301-L383)、[permissions.rs:388-406](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/protocol/src/permissions.rs#L388-L406)、[permissions.rs:659-667](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/protocol/src/permissions.rs#L659-L667)。

### 2. 允许读取的路径

在 Guardian 的 read-only sandbox 内：

- 绝对路径不要求位于 cwd 或 workspace；
- 相对路径按当前 turn/environment 的 cwd 解析；
- 目录遍历、文件读取、shell 中的 `cat`/`rg`/`find`/`ls` 等读取动作都受同一个 filesystem profile 约束，而不是独立的路径 allowlist。

Guardian 使用普通 Codex tool runtime；源码中没有一个只允许 `read/grep/find/ls` 的 Guardian 专用工具过滤器。标准 shell handler 仍是普通工具注册的一部分，读取安全性依赖它执行时使用的 permission profile。

证据：[review_session.rs:798-835](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/review_session.rs#L798-L835)、[handlers/mod.rs:1-66](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/tools/handlers/mod.rs#L1-L66)、[shell.rs:1-205](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/tools/handlers/shell.rs#L1-L205)。

### 3. 拒绝读取/写入的路径

Codex Guardian 自身没有继承 parent turn 的 `deny-read` 列表作为 filesystem deny rules。它把 parent turn 的 deny-read roots/globs 作为 prompt 中的政策上下文，并明确要求 Guardian 不要批准“为了读取这些路径”的 escalation；但 child session 随后被设置成新的 `PermissionProfile::read_only()`。

因此应区分：

- **Guardian 自身的读取**：原则上可以读取 read-only sandbox 可见的全盘路径，包括 cwd 外路径；
- **Guardian 判断的待批准 action**：不能因为 parent turn 的 deny-read 路径而批准绕过该限制的 escalation；
- **写入、删除、修改**：read-only profile 不提供 file-write capability，平台 sandbox 应拒绝；
- **网络**：read-only profile 默认是 restricted network。若 parent session 配置了 managed network，Guardian 可复用受控的 managed-network allowlist，但不是自由网络。

证据：[prompt.rs:244-266](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/prompt.rs#L244-L266)、[review_session.rs:798-823](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/review_session.rs#L798-L823)、[review_session.rs:1031-1058](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/review_session.rs#L1031-L1058)。

## Path normalization 与 symlink 行为

### 1. Codex deny-read matcher

当 policy 确实包含 deny-read entries 时，Codex 对 exact deny path 同时保留：

- lexical/normalized path；
- 目标存在时的 canonical path。

读取检查会同时比较请求路径的这些候选形式，并按 subtree 进行 deny 匹配。因此，直接路径和已解析 symlink target 都不会因为换一种路径拼写而绕过 deny-read matcher。

证据：[permissions.rs:249-348](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/protocol/src/permissions.rs#L249-L348)、[permissions.rs:1460-1479](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/protocol/src/permissions.rs#L1460-L1479)。

### 2. macOS / Linux / Windows enforcement

- **macOS**：read-only full-disk policy 生成 `(allow file-read*)`，但不生成 file-write allow；Seatbelt base policy 是 closed-by-default。policy path 会先 canonicalize；若有 deny-read roots，读取规则会在根路径上加 exclusions。
- **Linux**：permission profile 会序列化并传给 `codex-linux-sandbox` helper；helper 负责 bubblewrap + seccomp/相关 sandbox enforcement。
- **Windows**：使用 restricted-token sandbox。deny-read exact path 同时规划 lexical path 和已存在的 canonical/reparse target，并通过 deny-read ACL 应用。

证据：[seatbelt.rs:623-750](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/sandboxing/src/seatbelt.rs#L623-L750)、[seatbelt_base_policy.sbpl:1-13](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl#L1-L13)、[landlock.rs:15-59](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/sandboxing/src/landlock.rs#L15-L59)、[manager.rs:272-405](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/sandboxing/src/manager.rs#L272-L405)、[deny_read_acl.rs:11-79](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/windows-sandbox-rs/src/deny_read_acl.rs#L11-L79)。

## 与当前 pi-permissions Guardian 的差异

### pi 当前实现

当前 [src/guardian-tools.ts:55-87](../../src/guardian-tools.ts#L55-L87) 只做了两件事：

1. 从 `createReadOnlyTools(cwd)` 过滤出 `read`、`grep`、`find`、`ls`；
2. 直接调用对应 tool 的 `execute()`。

它没有：

- workspace/cwd containment check；
- allowlist/denylist path check；
- `realpath`/canonical target boundary check；
- OS-level sandbox handoff；
- 对 `filesystemDenyRead` 的执行层 enforcement。

Pi 工具自身也接受 absolute path，并用普通 Node filesystem、`rg` 和 `fd` 读取。`resolveToCwd()` 只负责将相对路径解析到 cwd，并不把 absolute path 限制在 cwd 内；`read` 直接使用 resolved path 进行 access/read，`grep`、`find`、`ls` 同样使用 resolved path。

证据：本地 [src/guardian-tools.ts:55-87](../../src/guardian-tools.ts#L55-L87)；Pi runtime [path-utils.js:39-47](../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js#L39-L47)、[read.js:130-190](../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js#L130-L190)、[grep.js:72-143](../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js#L72-L143)、[find.js:80-115](../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/find.js#L80-L115)、[ls.js:54-88](../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/ls.js#L54-L88)。

### 对齐判断

| 能力 | Codex Guardian | 当前 pi Guardian |
| --- | --- | --- |
| 工具形态 | 普通 Codex tools，主要通过 shell/runtime 使用 | 明确暴露 `read/grep/find/ls` |
| cwd 外绝对路径读取 | read-only sandbox 可读，边界由 OS sandbox 决定 | 可读，直接由 Node/rg/fd 执行 |
| workspace containment | 没有 workspace-only 限制；是全盘只读 profile | 没有 containment |
| parent deny-read | prompt policy context；不是 Guardian child 的 deny-read enforcement | 目前仅进入 review context，`guardian-tools` 不执行检查 |
| symlink/path normalization | deny-read 路径同时检查 lexical + canonical；平台 sandbox 继续 enforcement | 仅普通路径解析；没有安全边界级 canonical deny 检查 |
| 写入/删除 | read-only profile + platform sandbox 拒绝 | Guardian 工具集合本身没有写工具；但没有 OS sandbox 作为读取边界 |
| sandbox enforcement | Seatbelt / Linux helper / Windows restricted token | `guardian-tools` 内没有 sandbox handoff |

## 对实施的直接含义

如果目标是“Guardian 限制与 Codex 对齐”，不应把目标定义成“只允许 workspace 内 `read/grep/find/ls`”。Codex 的实际语义是：

1. Guardian 可读取 sandbox 可见的绝对路径；
2. Guardian 不具备写入能力；
3. parent turn 的 deny-read 是 Guardian 的审查规则上下文，而不是简单复制到 Guardian read tool 的 allow/deny list；
4. 真正的安全边界来自 OS sandbox，而不是 tool name 过滤；
5. symlink/path normalization 必须在 deny-read policy 和平台 enforcement 层处理，不能只依赖 prompt。

因此，当前 pi 的 `read/grep/find/ls` 工具名称集合已经接近“只读工具面”，但路径限制语义并没有与 Codex 完全相同：它既没有 Codex 的 OS sandbox enforcement，也没有 Codex 的 lexical/canonical deny-read matcher。若只做 Codex 语义对齐，最重要的是明确并实现“全盘只读 + 外部 sandbox enforcement”这一模型；若产品还要求“workspace-only”，那是比 Codex Guardian 更严格的额外策略，不能声称是 Codex 对齐。
