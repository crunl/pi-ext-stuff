# Nono、Codex “Approve for me” 与 pi-permissions 对照（2026-08-28）

> 状态（2026-08-28 更新）：本文关于 Nono backend 的结论已被当前工作树的
> SRT 0.0.74 executor 重构取代；保留本文仅作历史研究记录。当前架构以
> `src/sandbox/srt-enforcer.ts`、process-global coordinator 与统一 execute seam
> 为准。

> 范围：Nono 官方文档、OpenAI 官方 Codex 文档，以及本仓库当前工作树（含未提交改动）。OpenAI 资料仅引用 `learn.chatgpt.com`。下文用 **文档事实**、**源码事实**、**推断** 明确证据层级；推断不是上游承诺，也不是性能实测。

## 结论先行

1. **不能据现有证据断言 “Nono 本身很拉胯”。** Nono 的 Landlock/Seatbelt 执行边界、默认拒绝的 profile、supervised proxy 和 Tool Sandbox 都是合理的安全原语。真正不匹配的是当前 pi 集成拓扑：它把 `nono run` 当成每次 bash、文件操作和 Guardian 检查的热路径 wrapper，而 Nono 文档把 `nono run` 定义为有常驻父监督器、审计和可选回滚能力的 supervised 模式；“最低开销”的是没有这些能力的 `nono wrap`。[Nono execution modes](https://nono.sh/docs/cli/features/execution-modes)
2. **当前 pi 的 “Approve for me” 已经接近 Codex Auto-review 的核心决策语义**：独立 Guardian 代替人类判断；ordinary approval 不改变 base sandbox 或产生持久 permission grant，只形成绑定 invocation 的 exact one-shot lease；拒绝可由 `/approve` 触发一次精确重试，但重试仍要经过 Guardian；重复拒绝有熔断。决策与能力状态由 [`approve-for-me-engine.ts`](../../src/approve-for-me-engine.ts) 集中拥有，Pi 宿主接线在 [`register.ts`](../../src/register.ts) / [`pi-approve-for-me-adapters.ts`](../../src/pi-approve-for-me-adapters.ts)，显式持久能力请求由 [`permission-amendment.ts`](../../src/permission-amendment.ts) 规范化。Codex 的同类语义见 [Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)。
3. **两者还不是同一套边界模型。** Codex Auto-review 消费的是 native sandbox/approval 层产生的真实越界事件；pi 先做静态 risk 分类，再由 Nono 执行 profile。静态分析没有预见到的动态路径或主机名会直接被 Nono 拒绝，不会自然回到 Guardian 形成 runtime escalation loop。pi 新增的 `request_permissions` 是显式补偿通道，并且**当前已经走 Guardian**，不是旧笔记中的人工或静态直批路径。
4. 用户看到的 `deny_domain '::1' includes a :port suffix` 是 **旧版 profile 翻译问题的证据，不是 hang 的充分证据**：当前 renderer 会过滤 IPv6 literal，不再把 `::1` 写入 Nono 的 hostname rule。当前宿主还为 bash 设置 120s 默认 deadline、为每个 file helper 设置 30s 默认 deadline；每次 Nono probe 与 profile preparation 各有 5s deadline。Nono 自己仍默认没有 startup timeout。warning 只是在 stderr 输出，不能单独证明它让进程存活。

## 1. Nono 的模型与 CLI 生命周期

### 1.1 Sandbox 与 profile

- **文档事实：** Nono 在 Linux 使用无特权 Landlock，在 macOS 使用 Seatbelt；规则由内核执行并由子进程继承。Landlock 限制一旦应用不能在同一进程里撤销。[OS sandbox](https://nono.sh/os-sandbox)
- **文档事实：** profile 是能力集合，文件系统可配置 `allow`、`read`、`write`、`deny`，network 可 `block`；CLI、用户和 pack profile 有明确优先级。[Profiles & groups](https://nono.sh/docs/cli/features/profiles-groups)
- **文档事实：** Nono 的默认网络不是阻断。`--block-net` 才是全断网；`--allow-domain` 或 network profile 会启动 supervised HTTP/CONNECT proxy，并强制使用 supervised 模式。代理运行在未沙箱化父进程中，子进程只允许连随机 localhost 端口并用随机 token 鉴权。[Network filtering](https://nono.sh/network-filtering)、[CLI flags](https://nono.sh/docs/cli/usage/flags)

### 1.2 `run`、`wrap` 与长生命周期

- **文档事实：** `nono run`/shell 是 supervised execution：父进程在 sandbox 外监督子进程，提供 audit、可选 rollback、诊断、network proxy，以及 Linux 上可选的能力扩张。代价是更大的进程/攻击面。`nono wrap` 则在应用 sandbox 后直接 `exec` 目标，没有父监督器，文档明确将它定位为 minimal overhead，但它没有 audit、rollback、动态 expansion 和 network proxy。[Execution modes](https://nono.sh/docs/cli/features/execution-modes)
- **文档事实：** supervised execution 默认给每次 run 写 session audit 和 tamper-evident event log；`--no-audit` 才关闭。Nono 默认没有 startup timeout，需显式传 `--startup-timeout`。[CLI flags](https://nono.sh/docs/cli/usage/flags)
- **文档事实：** Nono 也支持由 PTY supervisor 管理的长生命周期 attached/detached session，并提供 `nono stop` 的 TERM→KILL 清理流程。[Session lifecycle](https://nono.sh/docs/cli/features/session-lifecycle)
- **文档事实：** Nono 自己为 agent 工具热路径设计的方案叫 Tool Sandbox：一个长生命周期 Capability Broker 按 invocation fork/exec 出独立、最小权限的 ephemeral child，每条命令可有独立 filesystem/network/env/credential/output 规则，也可在 fork 前走 approval backend。[Tool Sandbox](https://nono.sh/docs/cli/features/tool-sandbox)
- **文档事实：** `nono-ts` SDK 的 `apply()` 是把不可逆 sandbox 应用到当前 Node 进程并传给子进程；它不是可在同一宿主进程里反复 apply/unapply 的逐工具替代品。[TypeScript SDK](https://nono.sh/typescript-sdk)

### 1.3 Nono 对 Codex 的官方建议

- **文档事实：** Nono 的 Codex 指南建议只保留一个 sandbox 层：在 Nono 下运行 Codex时关闭 Codex 内置 sandbox，但保留 Codex approval flow，避免 nested sandbox 的重复拒绝。[Using Nono with Codex](https://nono.sh/docs/cli/clients/codex)
- **推断：** 这说明 Nono 预期的主用法更接近“外层长生命周期隔离整个 agent”，而不是在已运行的 agent 内为每个底层文件 helper 再启动一个完整 `nono run` session。

## 2. Codex 官方 “Approve for me” 的边界

### 2.1 Auto-review 不等于放宽权限

- **文档事实：** Auto-review 只把原来交给用户的 interactive approval 路由给独立 reviewer agent；主 agent 仍处于原 sandbox、filesystem roots、network policy 和 approval policy 中。它是 reviewer replacement，不是 permission grant，也不会让 sandbox 变宽。[Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)
- **文档事实：** 只有本来需要 approval 的边界操作才触发 reviewer，例如 shell sandbox escalation、被阻断网络、工作区外写入、`request_permissions`、app/MCP approval，以及 Computer Use 新 domain；sandbox 内普通命令不审。`approval_policy="never"` 下没有 interactive approvals，因此 Auto-review 没有可接管的请求。[Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)
- **文档事实：** reviewer 看到 compact transcript、精确请求和相关 tool evidence；可做少量只读检查。超时/错误 fail closed，动作不执行。连续 3 次拒绝或最近 50 次中 10 次拒绝会触发 circuit breaker；`/approve` 只对精确拒绝记录发起一次 retry，retry 仍经过 Auto-review 和策略检查。[Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)

### 2.2 Sandbox、approval 与 profile 是相互独立的层

- **文档事实：** Codex 把 sandbox 解释为 OS-enforced technical boundary，把 approval 解释为是否允许尝试越界的策略层。CLI/IDE 默认 workspace write、网络关闭；macOS 使用 Seatbelt，Linux 使用 bubblewrap，Windows 使用 native sandbox。[Sandboxing](https://learn.chatgpt.com/docs/sandboxing)、[Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)
- **文档事实：** permission profile 可分别表达 `read`、`write`、`deny`，内置 `:workspace` 包含工作区和 system temp 写权限；network enable 与 network proxy enable 是两件事——网络开但 proxy 关意味着 command 可直接联网，二者都开才执行 domain policy。[Permissions](https://learn.chatgpt.com/docs/permissions)
- **文档事实：** command network proxy 默认关闭，allowlist 优先且 deny 获胜，并有 private/local target guard；它只覆盖 local command traffic，不覆盖 web tools、apps/MCP、browser、Computer Use 或 cloud client，这些 surface 有自己的审批/网络层。[Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)
- **文档事实：** Codex 配置可独立选择 `approvals_reviewer=user|auto_review`，并按 `sandbox_approval`、rules、MCP elicitations、`request_permissions`、skill approval 等类别细分，app 还可有自己的 reviewer/tool approval mode。[Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

## 3. 当前 pi-permissions 的实际实现

以下是 **源码事实**，描述的是 2026-08-28 当前未提交工作树，不沿用 08-27 旧研究笔记的结论。

### 3.1 Reviewer 与 grant

- 当前只有 `auto | yolo` 两个模式；UI 的 `Approve for me` 对应 auto，人工 popup 模式已退休。所有 static risk decision 的 `prompt` 分支都进入 Guardian；hard block 不会送审，yolo 则绕过 review 和 sandbox。[`mode-runtime.ts`](../../src/mode-runtime.ts)、[`register.ts`](../../src/register.ts)
- [`ApproveForMeEngine`](../../src/approve-for-me-engine.ts) 在 Guardian 批准后生成绑定 session/config/ownership/tool/exact input/cwd/metadata/call id 的 one-shot grant；执行入口验证并消费它，普通 approval 不修改 base sandbox policy，也不形成持久 permission grant。实际边界由 [`pi-approve-for-me-adapters.ts`](../../src/pi-approve-for-me-adapters.ts) 交给对应执行 owner。
- `/approve` 从 Engine 的 bounded denial notices 中选择一条，arm 一个 exact retry handle；新 turn 重发同一 action 时仍经过 Guardian，且只允许这一次 retry。Engine 按当前 turn 统计连续 3 次 deny，或最近 50 次中 10 次 deny，打开 breaker；这与 Codex 文档公开规则一致。[`approve-for-me-engine.ts`](../../src/approve-for-me-engine.ts)、[`guardian-policy.ts`](../../src/guardian-policy.ts)
- Guardian review 总 deadline 为 90 秒、最多 3 次 provider attempt；Guardian 会话按 cwd/config/provider/model 维持 trunk，并在并发时 fork。[`auto-reviewer.ts`](../../src/auto-reviewer.ts)、[`guardian-session.ts`](../../src/guardian-session.ts)

### 3.2 `request_permissions` 已进入 Guardian

- `request_permissions` 明确声明 `turn | session` scope，可请求 filesystem write roots 和 public network hosts。risk policy 对非空请求返回 `REVIEW`；Engine 以 `permission-amendment` ownership 送入 Guardian。只有 Guardian 批准且 acknowledgement executor 成功后，Engine 才写入 turn/session capability world；它是唯一会形成 scoped amendment 的路径。[`risk-policy.ts`](../../src/risk-policy.ts)、[`approve-for-me-engine.ts`](../../src/approve-for-me-engine.ts)、[`permission-amendment.ts`](../../src/permission-amendment.ts)、[`register.ts`](../../src/register.ts)
- turn amendment 在 `agent_end`/`agent_settled` 清除；session amendment 在 session start/tree change/shutdown 等 permission context reset 时清除。它不写磁盘，也不改变 base sandbox config。[`register.ts`](../../src/register.ts)、[`approve-for-me-engine.ts`](../../src/approve-for-me-engine.ts)
- host 必须规范化为 public network target；private/special-use target 被硬拒。write root 不允许 glob，并会检查 permission-control protected paths、可行 allow path 与 symlink aliases。[`permission-amendment.ts`](../../src/permission-amendment.ts)

### 3.3 Nono 翻译与每次调用的进程路径

- 内部 `SandboxPolicy` 保留 `denyRead`/`denyWrite`，但 Nono profile renderer 把两者 union 成统一 `filesystem.deny`，所以落到 Nono 后失去“只禁读/只禁写”的差异。允许网络为空时只写 `{block:true}`，避免冗余 `deny_domain` 触发 supervised proxy；有 host grant 时写 `allow_domain`，从而进入 Nono supervised proxy 模式。[`nono-enforcer.ts`](../../src/sandbox/nono-enforcer.ts)
- `SandboxPolicy.filesystem.grantableDenyWrite` 只标记 cwd 默认 `.git` protected root 的实际/alias deny identity；它由 Engine 在 exact filesystem write grant 中消费，`.agents`、`.codex`、权限配置和配置 deny 仍是 hard deny。Nono renderer 只读取最终 `allowWrite`/`denyWrite`，不会把该 metadata 写进 profile。[`sandbox.ts`](../../src/sandbox.ts)、[`approve-for-me-engine.ts`](../../src/approve-for-me-engine.ts)
- 每次 `wrapWithSandbox` 都在 temp 目录生成新的 profile JSON，并返回 `nono run --silent --profile ... -- /bin/bash -c ...`；`--silent` 只隐藏 Nono banner/summary/status，子进程输出和 fatal diagnostics 仍保留。调用没有传 `--no-audit`、`--startup-timeout`，也没有复用 Nono session。[`nono-enforcer.ts`](../../src/sandbox/nono-enforcer.ts)
- `wrapWithSandbox` 的 `nono --version` probe 有固定 5 秒 deadline；probe 超时会 kill child 并 fail closed。profile 的 mkdir/write 准备阶段也有独立 5 秒总 deadline；caller abort 只取消当前等待，不会污染共享 probe。超时/abort 不依赖 stderr parsing 或 replay。[`nono-enforcer.ts`](../../src/sandbox/nono-enforcer.ts)
- pi 随后通过外层 `/bin/bash -c <wrapped command>` spawn 该命令，并等待 child 的 `close`。当前宿主已补上默认 deadline：bash 为 120 秒，所有 file/helper operation（包括 Guardian 的 read/grep/find/ls/inspect）为 30 秒（显式正数 timeout 仍可覆盖适用调用）。因此一次 `write`/`edit` 里的 mkdir、read、write、access helper，以及 Guardian 的只读 helper 不再无限等待，但仍可能分别启动 Nono supervised run。[`sandbox.ts`](../../src/sandbox.ts)
- Guardian 暴露固定的只读工具面：`read`、`grep`、`find`、`ls`、`inspect`。其中 `inspect` 采用固定 `{command:string}` schema，有参数和输出上限；外层固定 `/bin/bash -c`，命令可调用 PATH 上的本地程序，但执行受 Nono 只读/无网络 profile 与 30 秒 host deadline 约束，临时 scratch 遵循 Nono sandbox 默认值，不是无约束执行面。[`guardian-tools.ts`](../../src/guardian-tools.ts)、[`sandbox.ts`](../../src/sandbox.ts)
- 当前 network host filtering 全部交给 Nono per-call profile/proxy；Guardian 的只读 file/helper 与 `inspect` 都通过 Nono 只读 sandbox 执行。[`register.ts`](../../src/register.ts)、[`guardian-tools.ts`](../../src/guardian-tools.ts)、[`sandbox.ts`](../../src/sandbox.ts)
- 默认 deny domains 包含 `localhost`、`127.0.0.1`、`::1` 和 metadata 地址；renderer 会过滤 IPv6 literals 后再写 `deny_domain`，避免 Nono 将 `::1` 误解析为 port suffix。[`config.ts`](../../src/config.ts)、[`nono-enforcer.ts`](../../src/sandbox/nono-enforcer.ts)

## 4. 语义差异表

| 维度 | Codex 官方行为 | 当前 pi-permissions | 判断 |
|---|---|---|---|
| reviewer 角色 | 接管既有 interactive approval；不放宽 sandbox 或 base permission | Guardian 接管静态 risk 的 `prompt`；ordinary approval 只形成 invocation-scoped exact lease，不修改 base Nono policy | 核心思想一致，触发源不同 |
| 人类/自动选择 | `user` 与 `auto_review` 可配置，且可按 category/app 细分 | human popup 已退休，只有 `auto` 或完全 `yolo` | pi 控制面更粗 |
| runtime escalation | native sandbox/approval 层产生真实边界请求，可交 reviewer | Engine 支持 typed runtime denial，但当前 Nono adapter 不解析 CLI stderr；显式 `request_permissions` 是补偿通道 | pi 仍缺少完整 deny→review→retry 闭环 |
| filesystem | profile 区分 read/write/deny，平台实现原生 | 内部区分，Nono renderer 最终合并为 deny；temp 继承 Nono system group 例外 | pi 表达力有损 |
| network | persistent/integrated command proxy；其他 surface 分层 | exact lease host 触发每次 `nono run` 的 supervised proxy；原 persistent proxy 已删除 | pi 启停成本更高，覆盖面需逐 tool 看 |
| 外部 tools | app/MCP/Computer Use 各有独立审批与域规则 | generic tool 通过 host-admission 做 exact external-tool review；Nono 只拥有 bash/write/edit 等 sandbox-owned 执行，外部 side effect 由宿主工具负责 | reviewer coverage 不等于 enforcement coverage |
| permission lifetime | 官方公开 turn/session request，具体宿主生命周期由 Codex 管理 | ordinary approval 不持久；显式 amendment 的 turn scope 在 agent end/settled 清，session scope 跨普通 turn 保留，session/tree/config reset 清除 | pi 的边界已明确分层 |
| bypass | danger-full/yolo 关闭约束 | yolo 同时绕过 review 与 sandbox | 高层语义一致 |

## 5. “Nono CLI 是否适合热路径”的评估

### 已证实

1. Nono 文档自己区分了 supervised `run` 与 minimal-overhead `wrap`；domain proxy 只在 supervised 模式可用。
2. 当前 pi 每次调用重新写 profile，启动外层 bash、Nono supervisor 和内层 bash；默认还会生成 Nono audit session/event log。wrapper 带 `--silent`，因此不会把 Nono banner/summary/status 混进工具输出。
3. 当前 pi 已设置宿主级默认 deadline：bash 120 秒、file operation 30 秒；Nono probe 与 profile preparation 各有 5 秒 deadline。Nono CLI 本身仍没有默认 startup timeout。

### 推断

- **对延迟敏感的逐工具热路径，当前 `nono run` per operation 拓扑仍不合适。** 这是从固定进程/文件/audit/proxy 生命周期成本推导出的架构判断，不是已完成 benchmark 的数字结论。没有一手文档给出可以支持“零开销”或“必然很慢”的生产 SLA；宿主 deadline 解决的是无穷等待，不是启动成本。
- warning 后 UI 一直处于 running，更可能是上层仍在等 supervised child tree 的 `close`，或被执行命令本身仍存活；`::1` warning 本身没有证据会卡住生命周期。要定因必须记录 PID tree、child exit、Nono audit 尾部和 timeout/abort 事件。Nono 的 `--startup-timeout` 是未进入 alt-screen TUI 时的启动保护，不是通用 command deadline；本项目的 120s/30s host deadline 才负责 command lifetime bound。
- 对默认“网络全断”的大多数调用，若不需要 audit/rollback，`nono wrap` 更匹配 Nono 文档的低开销定位；但凡需要 domain allowlist/proxy，就必须继续 supervised，不能机械地全量替换。

## 6. 架构决策与已落地边界

- **决策：** `ApproveForMeEngine` 是 decision plane，具体执行 adapter 是 enforcement plane；Nono 只是可替换的 enforcement adapter。Engine 不依赖 Nono 的 CLI 输出或进程模型，`register.ts` / `pi-approve-for-me-adapters.ts` 负责把 sandbox-owned 能力交给 Nono，把 generic external tool 留给实际拥有副作用边界的宿主工具。
- **决策：** 当前 Nono adapter 采用每次调用生成 profile、启动 `nono run` 的路径。它有固定的进程、profile、audit，以及在 allow-domain 场景下的 proxy 开销；这是可解释的架构成本，不等于 Nono 或该调用必然卡死。是否使用 `run`、`wrap` 或其他 enforcement backend 属于 adapter 实现，不改变 Engine 的授权语义。
- **已落地的 bounded lifecycle：** `wrapWithSandbox` 的 probe 阶段最多等待 5s，profile `mkdir/write` 准备阶段最多等待 5s；bash 默认最多 120s，file helper 默认最多 30s。caller abort 会结束当前等待，执行层会清理被中止的 process group；probe 超时会 kill 探测 child，所有阶段超时均 fail closed。
- **已落地的 profile 边界：** 空网络 allowlist 只渲染 `network.block`；allow-domain 才渲染 hostname allowlist；IPv6 literal 不进入 Nono 的 `deny_domain`，避免 `::1` 被解释成 port suffix。Nono 的 warning 仍是诊断输出，不被当成 approval、成功或生命周期信号。
- **已落地的 denial 边界：** Engine 只根据静态 admission plan、Guardian outcome、精确 grant 和显式 `request_permissions` amendment 决策；它不解析 Nono stderr，不伪造 runtime escalation，也不因一次普通 approval 改写 base sandbox。若底层 enforcement adapter 能返回 typed denial，现有接口可以承接该结果，但当前 Nono CLI adapter 不宣称拥有这条闭环。

## 7. 最终判断

Nono 适合作为 **可替换的 enforcement adapter**，但当前 pi 把它的 supervised CLI session 用在细粒度函数调用上，因此会承担固定的 per-operation 启动成本。该成本已经被明确纳入 bounded lifecycle：probe、profile preparation、bash/file helper、abort 与 process-group cleanup 均有边界；它不是由 `::1` warning 单独造成的无穷等待。重构后的 `ApproveForMeEngine` 已把 admission、Guardian decision、invocation-scoped exact one-shot grant、deny breaker、`/approve` exact retry 与 turn/session amendment 集中到一个决策核心；`pi-approve-for-me-adapters.ts` 和 `register.ts` 只负责宿主接线及执行 ownership。ordinary approval 不改变 base sandbox policy，只有显式 `request_permissions` 才形成 scoped amendment。Engine 不解析 Nono stderr，也不把 CLI 拒绝伪造成 runtime escalation；如果 enforcement adapter 提供 typed denial，接口可以承接该结果。当前边界的核心是清晰分离 decision plane 与 enforcement plane，而不是承诺某一种 Nono 生命周期或把静态审批描述成真实 sandbox boundary 审批。
