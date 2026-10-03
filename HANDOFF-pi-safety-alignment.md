# 交接：pi-safety ↔ openai/codex 静态风险分析层对齐核查

> 由上一个 session 在上下文耗尽前写出。所有事实均来自该 session 亲自读取的真实源码；
> 未核实的推断已明确标注。以此为起点继续，**不要相信任何"Lane 报告"**（见 §6 踩过的坑）。

## 1. 目标（用户原话，逐字）

> 「把 pi-safety 和 openai/codex 的静态风险分析层完全对齐——不更严也不更松」

用户确认的执行方式（代号 **A 项**）：

- 由主 session **本人**对照真实 codex-rs 源码核查，**不派子代理**。
- **只读研究**。产出是一份带真实 `file:line` 的**行为差异清单**，每条标注
  `pi 更严 / pi 更松 / 等价`，并给出双侧证据。
- **未经用户批准不得改动代码。** 先交清单，等批准。

## 2. 真实路径（已核实存在）

| 用途 | 路径 |
|---|---|
| pi 扩展仓库根 | `/Users/x1a2h1/workspace/tsnjs/pi-ext-stuff` |
| pi-safety 源码 | `/Users/x1a2h1/workspace/tsnjs/pi-ext-stuff/extensions/pi-safety/src/` |
| codex 参考源码（临时克隆） | `/tmp/codex-probe/codex-rs/core/src/`、`/tmp/codex-probe/codex-rs/protocol/src/` |

**注意**：`/tmp/codex-probe` 曾被系统清理过一次。开工前先 `ls` 确认；若为空，重新浅克隆
`openai/codex`（需要 github.com 网络权限，用 `request_permissions`）。

### pi-safety/src 文件清单（行数为实际长度）

| 文件 | 行数 | 角色 |
|---|---|---|
| `risk.ts` | 424 | **核心分类决策引擎**（对齐重点） |
| `rules.ts` | 263 | 11 条规则注册表 |
| `dangerous-command.ts` | 263 | 危险命令判定 |
| `network.ts` | 58 | 网络判定 |
| `shell-lexer.ts` | 102 | shell 词法分析 |
| `path-policy.ts` | 291 | 路径策略 |
| `risk-policy.ts` | 1021 | 风险策略（最大文件，分段读） |
| `engine.ts` | 211 | 引擎 |
| `register.ts` | 190 | 注册 |
| `config.ts` | 278 | 配置 |
| `guard.ts` | 143 | 守卫 |
| `delegation.ts` | 116 | 委派 |
| `amendment.ts` | 116 | 修订 |
| `audit.ts` | 92 | 审计 |

另有 `lib/` 下 12 个测试文件。

### codex-rs 关键文件

`core/src/`：
- `exec_safety_policy.rs` (100) — **命令安全评估入口**
- `dangerous_command.rs` (141) — 危险命令模式表
- `network_approval_policy.rs` (244) — **网络审批评估**
- `network_safety.rs` (228) — localhost / 回环判定
- `exec_approval_policy.rs` (67)
- `exec.rs` (527)
- `execpolicy/`：`safety.rs` (115)、`ast.rs`、`eval.rs`、`lookup.rs`、`parser.rs`、`shell.rs`、`types.rs`、`utils.rs`、`error.rs`

`protocol/src/`：
- `approvals.rs` (168)
- `network_policy.rs` (359)
- `sandbox_policy.rs` (1094)

## 3. 已读通的 codex 侧事实（可直接引用，均已核实）

### 3.1 命令安全评估流程

`assess_command_safety(command, sandbox_policy)` → `core/src/exec_safety_policy.rs:17`

1. `parse_program(command)` → `ExecProgram`；解析失败 = `ProgramParseError` → **Deny**（:22-24）
2. `ExecProgram::is_dangerous()` → `DangerousCommand{matcher}` → **Deny**（:27-32）
3. `ExecProgram::check_safety(sandbox_policy)` → 按 sandbox 模式分派（:35-40）：
   - `ReadOnly` → `ReadOnlyCommandSafety`
   - `WorkspaceWrite` → `WorkspaceWriteCommandSafety`
   - `DangerFullAccess` → `AlwaysSafe`
   失败 = `CommandSafetyError{err}` → **Deny**
4. 网络判定（:47-67，仅在非 `DangerFullAccess` 时）：
   - 命中允许列表 → `AllowedWithoutApproval{reason:"known-safe"}`
   - localhost 判定（含 `--localhost` / `-l` 等形式）→ `NeedsApproval{reason:"localhost-network"}`
   - 其他 → `NeedsApproval{reason:"network-access"}`

### 3.2 网络审批评估流程

`assess_network_approval(request, network_policy)` → `core/src/network_approval_policy.rs:90`

1. 解析 host + port → `host_or_ip`（:111）
2. `network_policy.lookup(host_or_ip)`（:121）：
   - `Allow` → `Allow{decision}`
   - `Deny` → `Deny{decision, reason}`
   - `Ask` → `NeedsApproval`（:145-157）
3. `is_localhost(host_or_ip)` → `network_safety.rs:189`（检查 `localhost` 字面量 + 已知 IPv4/IPv6 回环）
   - `true` → `NeedsApproval{reason:"localhost-network"}`（:169-175）
   - `false` → `NeedsApproval{reason:"network-access"}`（:176-180）

### 3.3 字段命名事实（曾用于否决一项改名）

- codex 静态层用**单数 `host`**：
  `NetworkApprovalContext { host, protocol }`（`protocol/src/approvals.rs:75`）、
  `NetworkPolicyDecisionPayload { host, protocol, port, reason }`（`protocol/src/network_policy.rs`）。
- codex 中**不存在** `networkHosts` 或 `networkTargets` 这类复数字段名。
- pi 侧：`networkTargets` 仅出现在 `PermissionRequest` 层
  （`rules.ts:21`、`risk.ts:164/170/297`、`risk-policy.ts:336/337/383/403`，共 8 处）；
  而 `networkHosts` 已是 pi 其余各层（config / delegation / amendment / engine）的统一叫法。
- **结论**：`networkTargets → networkHosts` 属于 pi 内部命名一致性清理，**与 codex 对齐无关**
  （既不更严也不更松），不应挂在"对齐"名下。是否做由用户单独决定。

### 3.4 pi-safety 是有意的 TS 重写

`risk.ts:41-47` 的注释直接引用 codex 的文件名与行号 —— 说明 pi-safety 静态层是对 codex-rs
静态安全分析的有意 TypeScript 移植。这是"完全对齐"可行的前提，但**不能**当作已对齐的证据；
每条判定仍需逐一比对。

## 4. 仓库当前状态（已核实）

> **重要：工作树并不干净，但脏的部分与本次任务无关，请勿触碰。**

- `extensions/pi-safety/` **完全干净** —— 本任务的工作区，可安全只读核查。
- `extensions/pi-core/` 有 **15 处未提交改动**（12 个 modified、新增 `pnpm-lock.yaml` 与
  `pnpm-workspace.yaml`、删除 `package-lock.json`），涉及 `ci.yml`、`biome.json`、
  `docs/architecture.md`、`package.json`、`src/tui/codemode-contract.ts`、
  `src/tui/codemode-tool.ts`、`src/tui/codemode-tree.ts`、`src/tui/user-message-bar.ts`
  及对应 `tests/*.test.ts`。
  - 这是**另一个会话/另一个 agent**（同仓库有一个 `opencode` agent 在 herdr pane `w29:pD`）
    正在做的 npm→pnpm 迁移与 codemode 改动，**不是本次对齐任务的产物**。
  - 不要 `git checkout` / `git stash` / `git clean` 它们；不要提交它们；核查时忽略 `pi-core`。
- 根目录未提交文件：`HANDOFF-pi-safety-alignment.md`（本文件）。
- 最近三项提交（均在 pi-safety，与本任务相关）：
  - `74e1c9b` — `filesystem` → `file_system`（`register.ts` / `risk-policy.ts` + 测试）
  - `8a97f7b` — `RuleMatch` + dangerous-wrapper-depth（6 文件，14 增 14 删）
  - `0758172` — docs(pi-safety)：修正 mirror 与 bare-npm 注释

## 5. 下一步（建议顺序）

1. 确认 `/tmp/codex-probe` 存在，否则重新克隆。
2. 逐字读 `extensions/pi-safety/src/risk.ts`（424 行，核心），对照 §3.1 的 codex 四步流程，
   逐条比对**判定顺序、Deny/NeedsApproval/Allow 的触发条件、reason 字符串**。
3. 读 `dangerous-command.ts`（263）对照 `core/src/dangerous_command.rs`（141）+ `execpolicy/safety.rs`（115），
   比对危险命令模式集合：**codex 有而 pi 无 = pi 更松；pi 有而 codex 无 = pi 更严**。
4. 读 `network.ts`（58）对照 `network_safety.rs`（228）+ `network_approval_policy.rs`（244），
   重点比对 localhost / 回环判定范围与允许列表。
5. 读 `shell-lexer.ts`（102）对照 codex 的 `execpolicy/parser.rs` + `shell.rs`，
   比对**解析失败时的行为**（codex 是 Deny，见 §3.1 步 1）—— 这是最容易出现严松偏差的点。
6. 读 `path-policy.ts`（291）对照 `protocol/src/sandbox_policy.rs`（1094）的
   ReadOnly / WorkspaceWrite / DangerFullAccess 三档语义。
7. 汇总成差异清单，每条：`pi 更严 / pi 更松 / 等价` + 双侧 `file:line` + 建议动作。
   **先交清单给用户，等批准再改代码。**

## 6. 踩过的坑（务必避免重蹈）

- **早期"Lane 报告"全部作废**：其中引用的 `packages/...` 路径是编造的，实际不存在。
  任何来自子代理转述的结论都必须自己在真实文件上复核后才能采用。
- **subagent / workflow 派发在本环境反复失败**，所以核查由主 session 直接做。
  不要再依赖子代理产出作为证据来源。
- **`/tmp/codex-probe` 会被清理**，长会话中要重新确认或克隆。
- **上下文极易触顶**：codex 侧 `sandbox_policy.rs` 有 1094 行，pi 侧 `risk-policy.ts` 有 1021 行，
  按需分段读（用 offset/limit 或只读相关符号），不要整文件吞。
- 交接产物**不要只放 `/tmp`**，本文件即为持久副本。

## 7. 沟通约定

- 默认中文，保留英文技术术语。
- 引用代码一律用 `路径:行号` 形式，路径带完整目录前缀。
- 结论先行；不要把核查过程当交付物。
