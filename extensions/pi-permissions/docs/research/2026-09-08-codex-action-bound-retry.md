# Codex 完整调用链复核：从诊断止血到动作绑定的重试

状态：只读研究与设计修正；未实施代码或权限策略变更。
日期：2026-09-08。

## 结论：修正上一轮的“最优雅”判断

**停止把有损 SRT 日志变成精确授权目标，仍然正确；由此推导“应删除日志触发的原生恢复作为最终设计”，证据不足。** Codex 的具体 `apply_patch` runtime 提供反例：失败只是新审核的触发信号，审核身份来自已解析的原 patch、cwd 和文件目标，不需要知道精确的失败 syscall 路径。

因此：

- **A：diagnostics-only** 是最小安全止血方案，不能称为保留原生恢复能力的最优终局。
- **B：action-bound reviewed retry** 是需要保留 native 恢复时更合适的设计方向：冻结动作身份与可解释的新权限范围，由 Engine 重新审核并控制至多一次重试；不从日志选择授权目标。
- B 不是现成的无行为变化小补丁，也不是照搬 Codex 去沙箱。需明确原生重试、目录范围和可能已有副作用的契约；无法满足时保持终止。

上一轮遗漏了具体 runtime override 和 Denied 的生产者。这不是上游后来改了相关代码：已比较的关键文件在两个提交之间没有变化。

## 克隆与版本证据

- 官方来源：`https://github.com/openai/codex.git`。
- 临时克隆：`/tmp/codex-denial-review.So1PzI/codex`，保留供复核。
- 当前快照：`95327467c3af9533ac25b171b3496b951fe425ed`，提交时间 `2026-09-08T05:12:10Z`，分支 main。
- 旧引用提交：`2bd71f96d41809b95ea881429a1b68eb48d089b6`，额外 fetch 到同一克隆；没有切换工作树。
- 父侧已运行两提交之间的 `git diff --exit-code`，确认 `core/src/tools/{orchestrator,sandboxing}.rs`、`core/src/tools/runtimes/apply_patch.rs`、`core/src/exec.rs` 无差异。子研究进一步检查了 native handler/safety/apply-patch 链；Guardian 路由另有重构，不与上述结论混同。
- 仅浅克隆并读取源码/测试；未安装依赖、构建、运行 Codex、执行平台 sandbox 测试或重跑 graphify。

下文 Codex 行号对应当前快照；本地插件行号对应研究时工作树。

## 一、typed denial 不等于可信的拒绝资源

[Codex denial.rs:5-72](https://github.com/openai/codex/blob/95327467c3af9533ac25b171b3496b951fe425ed/codex-rs/sandboxing/src/denial.rs#L5-L72) 明确写道：无法完全确定命令是否因为 sandbox 失败，当前使用退出码和输出关键词启发式。

`is_likely_sandbox_denied` 检查 sandbox 是否开启、非零退出，再检查 stdout/stderr/aggregated output 中的 `permission denied`、`sandbox`、`failed to write file` 等关键词。随后它可被包装为 `SandboxErr::Denied`；跨进程 exec-server 的 `sandbox_denied` boolean 也使用同类 classifier。

可调用链：

```text
execute_exec_request
  → finalize_exec_result
  → is_likely_sandbox_denied(output)
  → SandboxErr::Denied { output, network_policy_decision }
  → ToolOrchestrator
```

来源：`codex-rs/core/src/exec.rs:403-471,745-804`、`codex-rs/protocol/src/error.rs:37-46`、`codex-rs/exec-server/src/local_process.rs:1066-1118`。

这条 filesystem payload 没有权威 path/operation。普通失败、timeout、成功退出也并不等价。源码允许 false positive：输出命中关键词不证明内核拒绝了某个资源。**类型化包装不能提升来源真实性。**

`codex-rs/sandboxing/src/violation.rs:66-73,133-153,186-215` 另有推断路径，但用于诊断/tracing；相关 exec 调用点不把其 path 作为 approval action 的身份。

## 二、apply_patch 审核的是已知动作，不是日志中的路径

### 请求身份来源

```text
ApplyPatchHandler
  → parse/verify patch + cwd
  → ApplyPatchAction（解析后的变更、原 patch、cwd）
  → ApplyPatchRequest
  → build_approval_action(req)
  → Guardian / User approval
```

- `core/src/tools/handlers/apply_patch.rs:365-446`：解析、验证后进入执行。
- `apply-patch/src/invocation.rs:214-296`：解析目标，读取 Update/Delete 输入，计算变更并构造 action。
- [runtime:75-84](https://github.com/openai/codex/blob/95327467c3af9533ac25b171b3496b951fe425ed/codex-rs/core/src/tools/runtimes/apply_patch.rs#L75-L84)：approval action 从 request 复制 id、environment、cwd、files、patch、changes。

因此，**可信的授权身份可以来自原请求，不一定来自可信的拒绝路径。** 失败输出只负责触发是否值得重新审核的判断。

### 具体 runtime 覆盖了 OnRequest 默认值

[ApplyPatchRuntime:116-140](https://github.com/openai/codex/blob/95327467c3af9533ac25b171b3496b951fe425ed/codex-rs/core/src/tools/runtimes/apply_patch.rs#L116-L140) 同时声明：

- `escalate_on_failure() == true`；
- `wants_no_sandbox_approval(OnRequest) == true`。

这覆盖了 `Approvable` 的默认 false。此前只看默认实现，不能推出 apply_patch 在 OnRequest 下不恢复。相对地，UnifiedExec 使用默认行为，不能据此让任意 Bash 都自动重放。

### 新审核与第二次执行

[orchestrator:411-520](https://github.com/openai/codex/blob/95327467c3af9533ac25b171b3496b951fe425ed/codex-rs/core/src/tools/orchestrator.rs#L411-L520)：

- strict auto-review 下，首轮审核不覆盖无沙箱重试，需要 fresh Guardian review；非 strict 的审批复用规则不同。
- 再从同一 request 构造 action，执行至多第二次 attempt；第二次结果直接返回。
- filesystem retry reason 在 `:546-550` 是固定文字，不提取失败路径。

**不能直接照搬的部分：Codex 这条恢复通常撤去 filesystem sandbox，不是补一个精确路径权限。** 是否允许仍受 denied-read、管理策略等条件限制。Pi 保留 SRT、hard deny 和 delegation ceiling 的契约不应因本次修复被扩大。

## 三、Codex 也没有证明“单文件失败可无害重放”

- runtime 累积 committed delta，包括失败时已发生的效果：`core/src/tools/runtimes/apply_patch.rs:201-207,233-235`。
- 底层明确承认失败 write 可能已截断目标，令 delta 不再 exact：[apply-patch lib.rs:489-500](https://github.com/openai/codex/blob/95327467c3af9533ac25b171b3496b951fe425ed/codex-rs/apply-patch/src/lib.rs#L489-L500)。
- orchestrator 不以 delta 为空作为重试前提。冻结 patch 不等于冻结文件内容或 symlink 状态；重放可能再次失败。

因此应撤回本地注释中“Write/Edit 是 single-file，所以可以安全重入”的未经充分证明推论（`src/approve-for-me-engine.ts:1475-1480`）。一次性、重新审核、固定动作都是必要约束，但不能代替副作用分析。

## 四、对 Pi 的修正设计

### 保留的核心：日志永不选择授权目标

SRT 0.0.74 的清洗、Linux diagnostic-only 契约及路径关联问题并未被 Codex 反例推翻。必须移除 `SRT line → exact SandboxDenialCapability` 的转换；保留原始失败摘要与标注为有损观察的日志。

但不必把所有失败触发的恢复一并删除。应分开三个问题：

| 问题 | 数据来源 / 所有者 |
| --- | --- |
| 是否发生了值得重新审核的访问失败？ | 执行结果与诊断；只能作为候选触发信号 |
| 本次到底要重新授权什么动作与范围？ | 冻结的 action、可信父侧文件操作参数与明确的 retry plan |
| 是否准许、如何约束第二次执行？ | Engine 的 hard policy、fresh Guardian review、单次 lease 与生命周期控制 |

### 最小的可信信息已经在父侧

`src/sandbox.ts:932-960` 的 `runSandboxedFileOperation` 在启动固定 helper 前已经持有 `operation/path/cwd/commandId`。可用父侧类型化失败保存这次已知请求的身份及原错误。

**仅为了保留请求身份，不需要新的 helper JSON 协议。** 这个对象只能说“操作 O、请求目标 P 的子执行失败”，不能说 P 必然是失败 syscall 路径，也不能证明原因是 SRT 或此前没有效果。

### Engine 显式处理 native failed-action retry

新增/修订的本地契约应表达“对已知失败动作申请一次新的、范围明确的审核”，而不是把父侧目标重新标成 `capability-denied`。具体类型名留给实施设计，不声称存在现成上游接口。

复用已有 `policyCheck`、`runReview`、`executeAttempt` 和冻结 call 的机制，但明确：

1. 仅可信 native Adapter 可声明恢复资格；程序 stderr 不能声明 retry plan 或扩大 scope。
2. 原 tool/input/cwd 与审批对象保持绑定；路径保留真实身份，规范化不能改变合法文件名。
3. fresh review 必须看到要增加的 scope、完整动作和“首次可能已有副作用、准备重执行”的语义。
4. 仅在可解释、可执行的 sandbox policy delta 存在时尝试；仍在 SRT 内，hard deny/ceiling 不变。
5. 审核拒绝零重放；批准最多一次；取消、stale、第二次失败终止；不产生 turn-wide grant。
6. 不满足资格、没有可信目标或无法安全约束重入时，返回失败与诊断。
7. Bash 保持 terminal，不加入自动 whole-command replay。

现有 FS inline gate 并不存在：`src/approve-for-me-engine.ts:2000-2163` 的 `authorizeInlineCapability` 目前只支持 network。B 不是简单接上这个函数。

### 必须明确的两处权限/行为边界

**mkdir 与祖先：** helper 使用 recursive mkdir。请求目录、实际失败祖先、最终文件并不等价；目录创建可能部分成功。需要目录权限时应从明确的动作语义建模、展示并审核，不能猜日志，也不能自动逐级向上放权。Codex 的首轮父目录权限派生是它自己的显式 patch 模型（`core/src/tools/handlers/apply_patch.rs:239-285`），不是 Pi 可无条件照抄的规则。

**已覆盖 lease：** Pi 的 `riskForFileMutation` 通常已把外部文件目标纳入事前审核；现有 Engine 拒绝对已覆盖但仍失败的能力盲试（`src/register.ts:1661-1694`、`src/approve-for-me-engine.ts:1457-1473`）。必须保留这条保护。若没有另一个明确、最小且可执行的范围变化，重新审核同一目标并不能修复执行失败。

如果 B 要在可能部分成功后重入完整 Write/Edit，必须先定义并验证允许的重入条件，不能只标注“single-file”。只续跑失败子操作则需要另一种 continuation/lease 契约，不属于当前 whole-action retry 的无代价替换。

## 五、建议的实施选择与验收

**我的修正建议：以 B 为保留 native 恢复能力的设计方向；A 只作为可独立落地的止血切片。** 本轮没有实施任何一个方案。若目标严格限定为最小风险补丁，A 仍合理，但必须公开行为收缩；不能用“SRT 没有精确路径 API”否决 B。

实施 B 前先锁定：可重入的失败阶段、目录创建范围及已发生效果如何进入审核。随后在现有公开 Seam 上做回归：

- 空格/尖括号/控制字符日志不选择授权目标；授权身份来自父侧冻结请求。
- false positive 最多触发合规审核，不产生未审核 grant。
- read/access、mkdir、write 区分；缺失身份、启动故障、取消、非访问错误不冒充精确 write denial。
- mkdir ancestor 与部分成功；写入已截断；Edit 重读状态改变。
- hard deny、delegation ceiling、已覆盖 lease、stale 均不能被恢复路径绕过。
- fresh review 拒绝零重放、批准最多一次、再次失败终止、无 turn-wide grant；Bash 不重放。
- 原错误与 effects 警告保留；诊断查询失败不覆盖真实错误。

## 已读测试与验证限制

以下为源码中的测试断言，**本轮未运行 Rust 测试**：

- `core/src/exec_tests.rs:31-86,1089`：关键词检测、无 sandbox、成功退出、quick-reject、SIGSYS。
- `core/src/tools/runtimes/apply_patch_tests.rs:51-106`：OnRequest override；approval action 保留原 patch/cwd/PathUri。
- `core/src/tools/handlers/apply_patch_tests.rs:248-336`：move target、已可写路径不扩大父目录、outside 目标的目录范围。
- `core/tests/suite/unified_exec_process_events.rs:254-286,759-879`：仅返回 access-denied 文字的 fake executor，OnRequest 下收到 patch 审核，批准后第二次 `fs/writeFile` 的 sandbox 为 null。没有精确 denied path 的直接反例。
- `core/src/session/tests/guardian_tests.rs:883-1008`：sandbox-denied retry 使用 captured action policy/reviewer，并有两次 attempts。
- `apply-patch/src/lib.rs:1109-1170`：move destination 已写、删除 source 失败时保留部分效果。

没有验证跨平台实际重试原子性、恶意输出安全性或 B 的实现正确性；这些不能由阅读断言替代。

## 研究运行记录

两条只读研究分别负责 denial producer/审批链与 native patch/retry 链。原 denial lane `8b45db19-1b8e-432d-b6cb-4b2ea685175c` 在 steer 时中断，不计成功；同协议恢复任务 `7cd46b06-344f-4340-b66b-59c1d5955d89` 已完成。Native lane `9192c8da-816b-49c6-beb3-2d69d6dc01f7` 已完成。父侧直接复核了 classifier、runtime override、approval action、orchestrator、父目录权限模型及关键测试。

原始报告位于：

- `/Users/x1a2h1/.pi/agent/sessions/--Users-x1a2h1-.pi--/subagent-artifacts/outputs/7c2a2b76-2bc7-4486-9d98-021739d16338/research/codex-denial-origin.md`
- `/Users/x1a2h1/.pi/agent/sessions/--Users-x1a2h1-.pi--/subagent-artifacts/outputs/7c2a2b76-2bc7-4486-9d98-021739d16338/research/codex-native-retry.md`

研究期间 pi-permissions 既有 tracked diff hash 保持 `d4755349f74936675ac19fb25aedfd5ecdb6f52078bf386018ba3473a969a428`；临时 Codex 工作树保持干净。仅新建本报告，并给上一轮研究文档添加修正指引，不修改实现、配置或依赖。
