# Codex「Approve for me」/ Guardian 对齐调研

## 基准与结论

- 规范上游基准：[`openai/codex` commit
  `789c72dcf62d7439863d4d2846454f05b3d51db6`](https://github.com/openai/codex/tree/789c72dcf62d7439863d4d2846454f05b3d51db6)。比较范围是 Guardian
  的 policy、prompt、review parser 和拒绝后精确重试语义；未来上游变更不会自动继承。
- 本地实现基准：Task 1--3 完成后的
  `pi-permissions` `1777c963871e1c01d9de3588a603fe5204ccfcb5`，以及只补齐合法
  Git metadata 测试夹具的
  `27903f053d4d89d3f2e965cafa0ede3f9f3ac019`。本文件记录该实现，而不是把
  Pi 的整套权限执行面宣称为 Codex 的复制品。
- 核心分层：Guardian parser 只验证结构化响应契约；高风险是否可允许、授权证据的含义仍由 Guardian prompt/policy 决定。Pi 的 shell、Git metadata、受保护路径及网络判断是进入 Guardian 前的确定性本地策略，不属于 Guardian parity。

## Guardian 对齐项

| 主题 | 已对齐的实际行为 | 边界 |
| --- | --- | --- |
| policy、prompt 与输出契约 | `src/auto-review-request.ts` 的模板、默认 policy 和结果字段以固定 commit 的 Guardian 源文件为准；只要求 `outcome`，其余字段使用相应的 allow/deny 默认值。 | 本地命名可以提及 Pi，但不改变 policy 含义。 |
| parser | 先解析完整 JSON；失败时只尝试首个 `{` 到最后一个 `}` 的单对象恢复。非对象、缺失/非法 `outcome`、非法 enum 和非字符串 rationale 仍会拒绝；额外字段会被忽略。高/critical `allow` 不会被 parser 二次拒绝。 | 这是结构验证，不在 parser 重写 Guardian 的风险或授权 policy。 |
| 拒绝后精确批准 | approval ledger 将批准绑定到原 tool、input、cwd、config 与 action fingerprint；仅可消费一次，并由 Guardian 重新评估。传给可信 developer context 的首行精确为：`The user has manually approved a specific action that was previously \`Rejected\`.` 随后是序列化的 exact action。 | 人工批准不是直接执行，也不会扩大到相似命令或后续 action。 |
| retry / failure 边界 | Pi 保持 90 秒总 deadline、最多 3 次，且 review 异常不会自动执行 action。 | 具体 provider 错误分类和 UI 人工交接仍是 Pi 产品行为，不是对 Codex 内部实现逐行复刻。 |

固定 pin 对应的上游 Guardian 资料位于
[`policy.md`](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/policy.md)、
[`policy_template.md`](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/policy_template.md)、
[`prompt.rs`](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/prompt.rs)、
[`review.rs`](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/review.rs)
和 [`mod.rs`](https://github.com/openai/codex/blob/789c72dcf62d7439863d4d2846454f05b3d51db6/codex-rs/core/src/guardian/mod.rs)。

## Pi 确定性策略：有意独立于 Guardian parity

| Pi 行为 | 目的与实际边界 |
| --- | --- |
| quote/escape-aware shell scanner | 只对活跃的 substitution、redirect 和真正以 `-c`/`--command` 执行的 shell 判为结构风险；普通参数里的 `bash` 或 `fish` 不是 nested shell。Git metadata grant 必须是唯一、直接、无上述结构风险的 mutation segment。 |
| Git metadata ownership | `.git` 以 `lstat` 开始检查，拒绝 symlink，并验证普通仓库、linked worktree 与 submodule 的 metadata/back-pointer/`core.worktree` 所有权。失败闭合；只把验证后的 metadata roots 授予合格的直接 mutation。SSH remote 保持 SSH，读取配置不会重写 remote。 |
| Git remote 的网络目的 | implicit `fetch` 只使用每个 remote 的 `url`；implicit `push` 优先该 remote 的 `pushurl`，没有 `pushurl` 才回退 `url`。本地路径 `pushurl` 会抑制这份回退。单段解析后的 wrapped push（如 `env`、`command`、`sudo` 或 leading assignment）仍能选择 push purpose；显式 URL、nested shell、compound、redirect 与 fetch 不会误判为该路径。 |
| `git init` | 只为语法安全、单段、当前目录的 `git init` 或 `git init .` 处理初始化；bare、空参数或其他目标一律不获 metadata grant。当前目录没有 `.git` 时，prospective root 仅是 `realpath(cwd)/.git`；不会借用父仓库 metadata，存在 malformed/unsafe 当前 metadata 时仍失败闭合。 |
| Default / Auto / YOLO 分层 | Default 与 Auto 都先经过 Pi 确定性策略；仅 review-eligible 的 Auto 请求到 Guardian。YOLO 在风险 evaluator、Guardian、人工 approval 和 sandbox execution 前返回原生工具执行。 |

这些 Git/shell 规则解决 Pi 的权限边界问题；它们不是 Codex Guardian policy 的等价实现，也不应被用来推断两者的 ARC 或 sandbox 语义完全相同。

## 最终验证证据

- 六文件 focused suite：6/6 files、306/306 tests 通过。
- `npm run check`：`tsc --noEmit` 通过；列定的 12 个 source/test 文件通过
  `biome check --error-on-warnings`，无 warning。
- 完整 `npm test` 在外层 sandbox 首次仅因九个 filtering-proxy case 无法
  `listen 127.0.0.1` 而报 `EPERM`；在获准的本地 loopback 环境重跑同一命令后，
  20 files / 396 tests 通过，1 file / 1 test（外部 core regression）按设计 skip。
- `npm run core:check` 验证已安装 `agent-loop.js`，SHA-256 为
  `e4af3082d8c95203aff6bf7aa590e63d6cd1d0225723db271eeb315ded01dd63`；
  `npm run core:test` 的 abort-ignorant prepared-tool regression 为 1/1 通过。
- YOLO targeted suite 为 28 tests 通过、67 tests 因名称筛选 skip；覆盖在 native
  execution 前不运行 risk evaluator、Guardian、人工 approval 或 sandbox execution。
- 最终 runtime tree audit 中 `git diff --check` 通过，任务列出的八个
  runtime/test 文件相对 `HEAD` 无未提交差异。

## 已知非目标

- 不实现可复用的 Codex Guardian child-session manager（trunk/fork、rollout
  snapshot 等完整 child-session 生命周期）。
- 不复刻 Codex 的 Guardian lifecycle events、`GuardianAssessment` telemetry 或 app-server 协议事件。
- 不实现相同的 review sandbox internals；Pi 没有声称具备 Codex 那种独立的 `Never`、read-only、MCP/apps/skills/features 清空以及仅继承 approved network hosts 的内部审查会话。Pi 仍保留自身 sandbox profiles、network allowlist 和 native completion 调用模型。

## 结论

本次对齐的承诺是固定 pin 下 Guardian 的 prompt、结构 parser 与 exact post-denial approval context；Pi 的确定性 Git/shell hardening 额外且独立。因而“对齐”不表示相同的 review sandbox/network internals，也不扩展到 Codex 的 child-session 管理或生命周期遥测。
