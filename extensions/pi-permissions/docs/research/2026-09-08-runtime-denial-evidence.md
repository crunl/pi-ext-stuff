# Runtime denial：诊断与授权证据分离

状态：第一轮研究记录，尚未实施；未修改代码、依赖或权限策略。
日期：2026-09-08。依据安装版 SRT 0.0.74 和下文固定提交的 Codex 源码，不代表所有版本。

**后续修正：** 克隆 Codex 并追踪具体 runtime 后，确认 apply_patch 可以基于冻结动作而非精确拒绝路径做重新审核。本文关于有损日志不得生成授权目标的结论保留；diagnostics-only 应定位为最小安全止血，而非保留原生恢复能力的最优终局。见 [完整调用链复核与修正方案](2026-09-08-codex-action-bound-retry.md)。以下保留当时方案及证据作为研究历史。

## 第一轮推荐结论（已由后续复核限定适用范围）

**采用 observation-only 修复：停止从 SRT 日志构造精确 capability，保留诊断，复用现有失败通道。** 不仅替换正则，不新增权限状态机，也不为本次问题引入 SRT fork 或新 helper 协议。

必须公开的行为变化：SRT-backed write/edit 将不再仅凭日志触发运行时补权审核和自动重试。保留事前 Guardian 审核、显式权限请求、精确 action escalation，以及 Engine 已有的 typed capability 处理能力。Bash 仍不自动重放。实施前应确认接受这项行为收缩。

本次问题是“拒绝事实是否被准确表达”，不是“graphify 必须获准执行”。原 graphify 操作真正被拒绝的完整路径仍未知；此方案不能保证它执行成功，也不授权重新执行它。

## 第一性原则

1. **授权目标必须保持身份。** 用于展示的字符串可以转义、裁剪；用于精确授权的资源标识不能靠猜测恢复。
2. **失败、缺少某项能力、允许重试是三个独立判断。** EPERM 不是精确的 sandbox 权限请求；审核通过也不证明失败发生前没有副作用。
3. **Adapter 不得承诺底层无法证明的事实。** 当前 SRT 只能提供有损观察，不能通过更强的 TypeScript 类型或 confidence 字段变成权威拒绝收据。
4. **复用已有 Seam。** Adapter 负责执行与诊断；Engine 负责授权、生命周期和重试。已有 failed/error 通道能承接本次修复，无需增加一种权限状态。

例如 `/tmp/<draft>/result.txt` 与 `/tmp/draft/result.txt` 经删除尖括号可能得到相同文本。多对一变换不可由下游正则逆转；日志中没有尖括号，也不证明原路径没有尖括号。

## 已验证证据

下列文件行号对应本次工作树快照；`SRT/` 表示 `node_modules/@anthropic-ai/sandbox-runtime/`。

### 当前插件把诊断提升为了授权请求

- `src/sandbox/srt-enforcer.ts:47-58` 用 `file-write-* ... (\S+)` 提取路径；此前已实测 `Application Support/...` 被截为 `Application`。
- `src/sandbox.ts:186-216` 的 `SandboxDenialCapability` / `classifyDenial` 契约承诺“exact capability enforcement denied”。
- `src/register.ts:1454-1469` 将该结果变为 `capability-denied`，并生成确定性的 “Sandbox enforcement denied writing ...” 文案。
- `src/approve-for-me-engine.ts:1392-1557` 会规范化该请求、检查 policy，并在 Adapter 声明 `review-and-retry` 时，为符合条件的文件写入发起一次新的 Guardian 审核。因此问题不止是显示截断。

### SRT 没有可直接替代正则的精确路径 API

- `SRT/dist/sandbox/macos-sandbox-utils.d.ts:59-65` 的公开事件只有 `line`、可选 `command` / `encodedCommand`、`timestamp`，没有独立 path、operation 或完整性证明。
- `SRT/dist/sandbox/sandbox-violation-store.js:12-26,95-97` 入库时将控制字符变为空格并 trim，再删除 `<` / `>`；get 和 subscribe 都取得清洗后的事件。此前已通过实际 store 复现路径变化。
- `SRT/dist/sandbox/linux-violation-monitor.js:11-29` 明确说明它观察 write-intent attempts，而非 syscall 已被拒绝；路径从不可信进程内存读取，有竞态。原文：`the violation events emitted here are diagnostic hints and must never gate a policy decision`。内部 JSON path 因此也不能直接提升为授权证据。
- `SRT/dist/sandbox/macos-sandbox-utils.js:907-924` 对每个 stdout chunk 分别查找首条 deny 与首条 command tag，没有完整逐记录配对。由代码可推得存在丢事件/错配风险；本轮没有运行平台探测，不能将静态分析冒充实测。
- `SRT/dist/sandbox/sandbox-utils.js:690-698` 编码 command 标识前截断到 100 字符；`src/sandbox.ts:973-1008` 多个 helper 子执行沿用一个 callId。唯一 attempt ID 可以改善关联，但不能修复路径失真，也不能消除 producer 的限制。

### 现有失败通道已能保留副作用警告

- `src/approve-for-me-engine.ts:1308-1372` 对执行后的 failed outcome 添加 `effectsMayHaveOccurred: true`。
- `src/register.ts:1167-1191` 将其转为带原因的 `execution-failed`，保留该标志。
- `src/permission-copy.ts` 的 `execution-failed` 分支提醒先检查已发生的效果，再考虑重试。

因此不需要给 Engine/Pi facade 增加新的 RuntimeOutcome 分支，才能安全表达“操作失败，同时观察到这些不可靠的 sandbox 日志”。

## 最小实施计划（待批准）

### 1. 收窄 Sandbox Adapter 的 Interface

在 `src/sandbox.ts` / `src/sandbox/srt-enforcer.ts` 中，以明确仅供诊断的查询替代当前日志派生的 `classifyDenial`。具体命名在实施时按现有风格确定；这是拟议的本地 Interface，不是声称 SRT 已有此 API。

- 返回有界、可安全显示的观察文本，不返回从中解析出的 capability/path。
- 删除日志到精确 filesystem/network capability 的转换，不保留另一个隐藏入口。
- 保留日志中现存的空格等信息，不再按空白切路径；不要宣称已恢复被 SRT 删除的字符。
- 无事件、迟到事件、查询失败、取消、超时不得掩盖原始执行错误，不因缺少事件而认定执行成功。
- 日志仍可能不完整或关联不可靠，展示应明确说明；本轮不为诊断增加一个新的可靠收据协议。

### 2. register 只附加诊断，不升级权限语义

在 `src/register.ts` 的失败处理处复用 `{ kind: "failed", error }`：

- 原始失败原因保持主要位置，诊断作为标注“有损观察，不能据此确定精确补权目标”的附加信息。
- 不从日志创建 `capability-denied`，不把解析出的片段写进 grant 或 Guardian requested capabilities。
- SRT-backed native write/edit 不再声明/触发仅凭日志的 runtime review-and-retry。
- 不改变 Engine 的通用 typed capability 分支、事前审核、显式补权、hard deny、delegation ceiling 或审批预算。
- 不自动放开父目录、Library 或整个 home；不自动重跑 Bash。

### 3. 测试跟随 Interface，而不是保存坏解析器

在既有 Adapter / registered-tool 测试 Seam 上替换相应断言：

- 带空格路径仍作为完整诊断文本出现，不再生成截断的权限目标。
- 尖括号/控制字符丢失、普通无特殊字符日志、伪造 stderr、Linux attempt 文本均不能创建权限或触发自动重试。
- 无事件、延迟/错误关联、诊断查询异常：保留原始失败与副作用提示，不宣称精确拒绝。
- 原生 write/edit 的日志案例改为失败且无运行时补权审核；区分一个工具动作的多个子操作与“再次执行该动作”，不要把子进程次数当重试次数。
- Bash 失败后不重放；明确权限请求、事前 Guardian 与一次性精确 action escalation 的原有用例继续通过。
- Engine 的真实 typed capability 用例继续证明：保护规则有效、已覆盖但仍失败不盲试、最多一次已审核重试、不生成 turn-wide grant。

预计修改面：上述三个源文件、对应 `tests/srt-enforcer.test.ts` / `tests/register.test.ts`，以及承载相关契约的测试/文档。实施时按引用检查收敛范围，不顺带清理已有脏文件。

验收：先运行相关回归测试得到 red，再实现；随后 focused/full tests、TypeScript、相关 lint/LSP、diff 检查。保留基线已有改动。不以 graphify 成功为验收项；其恢复需独立检查副作用并获得合适授权。

## 为什么不选另外三种方案

| 方案 | 判断 |
| --- | --- |
| 只将 `\S+` 改成宽松正则 | 修复常见空格显示，但仍会把已损坏或错误关联的数据当成精确目标，不足以作为授权修复。 |
| 增加 confidence、raw/path 双字段 | 没有真实无损来源时，只是给同一份不可靠数据加标签；不能让 Adapter 满足精确拒绝契约。 |
| fork SRT 或引入自有 helper 的结构化拒绝协议 | 比本次修复更大。绕过 store 仍有 producer/平台限制；固定 helper 的结构化 EACCES/EPERM 也不是 SRT 拒绝证明。应作为独立需求。 |

自有 helper 可以提供独立的请求目标和结构化 fs 错误，但若用它保留自动重试，就要明确新增“可信固定文件动作的访问错误允许重新审核已知目标”的契约。需分别处理 requestedPath/error.path、递归 mkdir 的祖先与部分成功、read/access 语义、启动环境完整性及 attempt 归属。这不是此次截断 bug 的必要修复，不应悄悄塞进同一补丁。

## 与 Codex “Approve for me” 的关系

独立研究子代理重新核对了固定提交 `2bd71f96d41809b95ea881429a1b68eb48d089b6` 的一手源码：

- [orchestrator.rs](https://github.com/openai/codex/blob/2bd71f96d41809b95ea881429a1b68eb48d089b6/codex-rs/core/src/tools/orchestrator.rs)：175-307 将审核与 sandbox attempt 分开；322-442 对拒绝、工具是否支持 escalation、是否允许新审核分别处理；严格 auto-review 下，无沙箱重试需新审核。
- [sandboxing.rs](https://github.com/openai/codex/blob/2bd71f96d41809b95ea881429a1b68eb48d089b6/codex-rs/core/src/tools/sandboxing.rs)：330-337 默认不为 OnRequest 开启 post-denial 无沙箱审批；工具可覆盖默认，orchestrator 也存在窄 network-context 例外，不能泛化为所有工具。

这里可借鉴的是职责分离和明确的重试授权，而不是“失败后自动扩大权限”。这些代码也不提供恢复 SRT 日志路径身份的方法。该源码提交不被断言为本机 Codex 二进制的准确构建提交。

## 本轮验证与限制

- 已读源码、既有测试与独立研究输出；未执行 sandbox 程序或 graphify，未更改权限策略。
- 本轮新增的仓库内容仅此研究文档；未实施方案，因此未运行实现后的测试或宣称验证通过。
- 保存文档前，tracked diff SHA-256 仍为 `d4755349f74936675ac19fb25aedfd5ecdb6f52078bf386018ba3473a969a428`，`git diff --check` 通过；原有 untracked 路径仍在。
- 子代理完整证据记录：`/Users/x1a2h1/.pi/agent/sessions/--Users-x1a2h1-.pi--/subagent-artifacts/outputs/857bb8ad-e68a-4ec8-abf4-98d6b4e2c1ce/research/runtime-denial-evidence-sources.md`。
