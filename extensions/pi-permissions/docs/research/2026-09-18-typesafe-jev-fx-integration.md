# TypeSafe Jev / fx 接入方式与 pi-permissions 落点

## Scope

- Date: 2026-09-18
- TypeSafe docs: `https://docs.typesafe.ai`（llms.txt + api/primitives/confidence/guardrails/models 等；子代理 general-18）
- Vercel fx upstream: `vercel-labs/fx`（**不是** `vercel/fx`）
  - clone: `~/.graphify/repos/vercel-labs/fx`
  - 权限/Jev 相关源码已直接阅读
- Claude Code Auto Mode: 公开逆向文档（非 pin 源码），仅作分类器设计对照
- Prior: `docs/research/2026-09-18-guardian-alignment-graphify.md`
- This note does **not** implement product code. No commit/push.

## 结论（先看这个）

1. **TypeSafe Jev 可 HTTP 直接接入**：`POST https://api.typesafe.ai/v1/systemone`，`Authorization: Bearer`，body `{state, model, questions}`，response `{model, answers, usage}`。
2. **fx 生产已经接了 Jev**，落点是 **auto 模式 permission reviewer 的可替换后端**（`review_model: "typesafeai/jev"`），**不是** Guardian 之前的 shell 风险分类层。
3. **TypeSafe 官方文档**推荐的软件形态是 **pre-classifier + 代码阈值**（Guardrails cookbook：Noul 电池 + Score → pass/review/block），并明确 **“Nothing here is a security boundary”**。
4. **对 pi-permissions**：不要默认把 Jev 塞进 `reviewer` 去替代完整 Guardian（安全语义更宽 + policy floor + 证据工具）。更稳妥落点是 **admission/risk-policy 之后、Guardian 之前的可选分类层**（或 `reviewer.kind: "system-one"` 但必须保留静态 floor）。词汇用 pi 的 `Risk`/`action`（`LOW|REVIEW|HARD` / `allow|prompt|block`），不要照搬 Codex `Allow|Prompt|Forbidden`。

## TypeSafe 接入清单（文档）

| 项 | 值 |
|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` |
| Auth | `Authorization: Bearer <TYPESAFE_API_KEY>` |
| Model | `jev-latest`（alias→`jev-1.13.0`）；调阈值后应 pin 版本 ID |
| Request | `{ state, model, questions }`；questions: noul / choice / score |
| Response | `{ model, answers, usage }` |
| Noul answer | `answers.<id>.noul` ∈ [0,1]；**无** confidence 字段 |
| Choice answer | `choice`, `probabilities`, `confidence` |
| Score answer | `score`, `legend`, `probabilities`, `confidence` |
| Batch | 同 state 多 question 并行；~32k token 预算；加题几乎不增延迟 |
| Latency 宣传 | ~100ms |
| Price | $0.042 / Mtok，**仅 input** |
| Fail | HTTP 整请求失败；无部分失败形状 → 接入方 fail-closed |
| 安全边界 | 文档明确 filter ≠ security boundary；对抗内容可移动答案 |

最近官方 recipe：Guardrails cookbook（Noul + Score → pass/review/block/support）；confidence-gated routing；atomic questions（代码组合，不问宽泛 “dangerous?”）。

## fx 生产如何接 Jev（源码）

配置面（`fx.sh/docs/configure-fx/permissions.md`）：

- 模式：`ask` | `auto`（默认） | `full-access`（legacy `yolo`）
- auto：先 rules/session grants，再 **automatic review** 未解决动作
- `review_model` / `FX_REVIEW_MODEL`：Gateway 上可选 chat 模型或特殊值 **`typesafeai/jev`**
- 直连：`TYPESAFE_API_KEY`（+ 可选 `TYPESAFE_BASE_URL`）；否则走 AI Gateway `…/v4/ai/evaluation-model`
- **Reviewer 失败（含缺凭证/端点不可达）→ hold 动作，不 unreviewed 执行**（fail-closed）

实现文件：

| 符号/文件 | 作用 |
|---|---|
| `src/core/permissions/auto_classifier.zig` | 统一 auto-review 协议：`Risk` low–critical + `Decision` clear\|caution + rationale；`HostDisposition` clear/caution/unavailable |
| `src/builtins/gateway/permission_reviewer.zig` | 默认 chat reviewer `openai/gpt-5.6-luna`；`review_model` 命中 Jev id 则改走 TypeSafe provider |
| `src/builtins/gateway/typesafe_permission_reviewer.zig` | System One 请求组装/解析/路由 |
| `tests/e2e/review-model-override.test.ts` | e2e：clear 执行 / caution hold / settings 选择 / 无 key 走 gateway / 失败 hold |

Jev 请求形状（`typesafe_permission_reviewer.zig` + e2e）：

```json
{
  "model": "jev-latest",
  "state": {
    "review_policy": "<composed policy instruction>",
    "review_context": "<context message>",
    "pending_action_tool": "shell",
    "pending_action_arguments": "<exact argv JSON>",
    "pending_action_call_id": "..."
  },
  "questions": {
    "decision": {
      "type": "choice",
      "instructions": "…using review_policy… prompt injection or malicious activity…",
      "criteria": { "clear": "…", "caution": "…" }
    }
  }
}
```

关键产品语义（`typesafe_permission_reviewer.zig:7-9,27-38`）：

- **与 LLM reviewer 同一槽位**：同一 composed policy / context / exact pending action。
- **单一 Choice**：`clear | caution`，映射到既有 `permission_decision` 工具调用，下游解析不变。
- **威胁模型偏窄**：caution 主要针对 concrete prompt injection / malicious activity；“destructive/risky/external 但不 malicious” → **clear**。
- **概率/置信度只进 rationale/trace，不作为门控**（`never gated on`）。
- 端点：direct `https://api.typesafe.ai/v1/systemone` 或 gateway evaluation-model。

## 对照：三种“决策模型”落点

| 方案 | 谁在用 | 槽位 | 输出 | 与静态规则关系 | 安全边界？ |
|---|---|---|---|---|---|
| **A. fx / Jev as reviewer** | vercel-labs/fx | auto automatic review（替代 chat LLM） | clear→执行；caution/unavailable→hold | rules 先过滤，未解决才进 reviewer | 产品当 gate 用，但 TypeSafe 文档说模型本身不是 security boundary |
| **B. TypeSafe 文档推荐** | cookbook / how-to-build | 软件里的 pre-classifier | Noul/Score/Choice + **代码阈值** 路由 | 代码保留最终控制 | 明确 **不是** security boundary |
| **C. Claude Code Auto Mode** | 公开逆向文档 | 静态 deny/danger 之后、人类弹窗之前的灰区分类器 | allow / soft_deny / hard_deny（LLM 两阶段） | hard floors 仍先挡；分类器只处理灰区 | 分类器是补充层，不是唯一门 |

Codex @ pin 的 Guardian 是 **sync LLM approval stage**（taxonomy allow|deny + policy floor），不是 Jev/Auto Mode 同类物；Luna async classifier 在 pin 上默认不覆盖 bash。

## pi-permissions 推荐落点

### 不推荐（默认）

把 `reviewer.model` / 新 `reviewer.jev` 直接做成 **Guardian 的完整替代**（纯 fx 式），除非产品明确接受：

- 失去完整 Guardian：policy floor、只读证据工具、session trunk、rationale 审计、multi-turn tool rounds；
- fx 的 caution 判据比 pi Guardian 窄（偏 injection/malicious，不是完整 risk×authorization floor）；
- TypeSafe jaggedness：对抗 state 可移动答案 → 不能单独当安全边界。

### 推荐落点（与现有双层对齐）

```text
static rules / dangerous-commands / RiskDecision (risk-policy)
        │
        ├─ HARD / block / deny rule          → 不进 Jev、不进 Guardian（与 Codex Forbidden 同构）
        ├─ LOW + 无 escalation + 无静态命中   → 可选：Jev classifier
        │       clear + 高置信度              → allow（少进 LLM；对齐 P0 方向）
        │       caution / 低置信 / 缺 answers → REVIEW → Guardian（fail-closed 进现有路径）
        └─ REVIEW / escalation / write-root … → Guardian（默认路径不变）
```

实现缝（概念层，未改代码）：

| 层 | 文件 | 建议 |
|---|---|---|
| 分类器 provider | 新 `src/typesafe-classifier.ts`（或等价） | `POST /v1/systemone`；问题用 atomic Noul 电池 + 可选 score/choice；**输出映射到 pi `Risk`/`action`**，不引入 Codex `Decision` 字面量 |
| 调用点 | `risk-policy.ts` / engine admission **之后**、`runReview` **之前** | 仅对本会进入 Guardian 的候选动作可选启用；不改 HARD/block |
| 配置 | `permissions.json` | 建议 `classifier: { provider: "typesafe", model: "jev-1.13.0", enabled: false, ... thresholds }`；**不要**默认挂在 `reviewer.model` 以免被误认为 Guardian 替代 |
| 失败语义 | adapter | HTTP/超时/缺 answers → **维持原 REVIEW→Guardian**，不 allow、不 block 新路径 |
| 观测 | `guardian-metrics.jsonl` 或并行字段 | 记录 classifier choice/noul/confidence/duration；与 N1/N2 正交 |
| 命名 | 配置与注释 | `classifier` / `systemOne`；避免 `reviewer.jev` 暗示“就是 reviewer” |

若要 **fx  parity 模式**（可选高级项）：`reviewer.kind: "system-one"` 时，Jev clear **仍必须**再过 `guardianPolicyFloorViolation` / 静态 HARD 检查；unavailable → deny/hold，禁止静默 allow。

### 建议 question 草案（阈值需自标定）

对齐 TypeSafe guardrails + fx “exact pending action” state：

- state：`command` / `tool` / `cwd` / 精简 `permissionContext` / 静态 `staticRisk` 元数据（不是完整无关 transcript）
- Nouls（示例名）：`destructive_fs`、`privilege_or_auth`、`network_exfil`、`obfuscated_effect`、`policy_conflict`
- 可选 Score：`severity`
- 可选 Choice：`route` = allow | guardian | unknown（**不要**让 Jev 直接产出 pi 的 HARD block）

组合逻辑在代码：`any noul≥action_threshold → REVIEW`；`choice.confidence` 低或 `unknown` → REVIEW；否则 static LOW 路径可 allow。**禁止**用单一宽泛 `is_dangerous` 替代多题。

## 与“vercel/fx Auto Mode 分类器基准”的澄清

| 说法 | 核实 |
|---|---|
| `vercel/fx` 仓库 | **不存在**；官方是 **`vercel-labs/fx`**（Zig，Apache-2.0，fx.sh） |
| fx “Auto Mode” | fx 有 **`permission_mode: auto`** + `auto_classifier.zig`；默认 reviewer 是 **chat LLM**（Gateway 默认 `gpt-5.6-luna`），**Jev 是可选 override** |
| “Auto Mode classifier” 基准讨论 | 公开材料主要指向 **Claude Code** Auto Mode（两阶段 LLM、soft_deny/hard_deny、denial circuit），不是 fx 源码里的同名组件 |
| TypeSafe 文档提 Vercel/Auto Mode | **未发现** |

若要做分类器 benchmark：可用 fx e2e 的 Jev stub 形状 + TypeSafe guardrails 场景 + 自建 shell 标注集；不要假设存在现成 “vercel/fx Auto Mode 基准套件”。

## 建议下一刀（若进入实现）

1. 设计文档级配置：`classifier.typesafe` 默认 **disabled**；阈值与 pin 的 `jev-1.13.0` 写死可审查。
2. 最小 spike：只读离线 stub + 映射到 `RiskDecision`，hermetic 测试：clear→仍尊重 dangerous；caution→进 Guardian；API 挂→进 Guardian。
3. **不要**本刀：Luna、strict_auto_review 默认开、删黑名单、用 Jev 替换 Guardian、把 confidence 当授权。

## Claude Code Auto Mode（社区所谓 “classifier 基线”）

来源：`https://www.anthropic.com/engineering/claude-code-auto-mode`（2026-03-25）。**不是** `vercel-labs/fx`。

| 维度 | 设计 |
|---|---|
| 动机 | 权限 prompt 约 93% 被同意 → approval fatigue |
| 双层 | Input：server-side prompt-injection probe；Output：transcript classifier（文称 Sonnet 4.6） |
| 两阶段 | Stage1 单 token yes/no（偏 block）；Stage2 仅对 flag 输入 CoT |
| 可见输入 | user messages + tool calls only（reasoning-blind；strip assistant 文/tool output） |
| 标签 | allow / block；deny-and-continue |
| 熔断 | 连续 3 / 会话 20 次 deny → 升人审；headless 可 terminate |
| 公开指标 | 真实流量 n=10k：Stage1 FPR 8.5% → 全管道 **0.4% FPR**；overeager n=52：全管道 **FNR 17%**；合成 exfil n=1k：FNR 1.8%→5.7% |

fx 仓库 **无** 同口径公开 shell-risk 标注集/FPR 表；`tests/evals/auto-permission-reliability*` 在树中但非公开 baseline score。社区 harness bench（含 fx）比的是 agent harness，不是 Auto classifier。

**pi 含义**：Jev pre-Guardian 若要验收，须 **自建 labeled shell-risk 集 + 自标定阈值**；不可把 fx/CC 数字当产品验收基线。可借鉴：exact-action binding、trust 分区（root user = 权威）、fail-closed `unavailable`、概率记账不门控。不可照搬：fx Jev caution 语义更窄（偏 injection/malicious，overeager destructive 可能 clear）。

## What this note does not claim

- 未在本机用真实 `TYPESAFE_API_KEY` 打过生产 API。
- 未读完 fx 全部 permissions 树；Jev 相关实现以父代理已读的 `typesafe_permission_reviewer.zig` / `permission_reviewer.zig` / `auto_classifier.zig` + e2e 为准（clone：`~/.graphify/repos/vercel-labs/fx`）。
- Claude Code Auto Mode 来自 Anthropic engineering 文 + 公开逆向，**不是**本仓库 Codex pin 源码。
- fx 文档与源码对 Gateway 默认 reviewer 名不一致（文档 `kimi-k3` vs 源码 `gpt-5.6-luna`）——不要写死为基线配置。
- 未修改 pi-permissions 产品代码。
