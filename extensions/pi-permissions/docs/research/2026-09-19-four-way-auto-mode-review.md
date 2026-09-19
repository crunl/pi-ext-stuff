# 四方 auto / approve-for-me 审批链路对照（2026-09-19）

## Scope

- Date: 2026-09-19
- Primary question: **minimax-code @ d9ee3a8 是否有 LLM/Guardian 式 auto 审批，还是只有静态规则？**
- Trees / SHAs:

| System | Path | SHA / pin | Access this session |
|---|---|---|---|
| fx (vercel-labs) | `/tmp/repo-research/fx` | **unread** (external_directory); GitHub main @ `34d262d71f32107ac2c82593fb06a3a5a7c8a6c2` (2026-09-19); prior research used `759001b3…` | webfetch raw @ main + prior T93/Jev note |
| Codex (OpenAI) | `/tmp/repo-research/codex` | pin **`129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`** (standing) | webfetch raw @ pin + prior notes |
| MiniMax Code | `/tmp/repo-research/minimax-code` | pin **`d9ee3a868611fe2eb3df4b7c765e8afb6e85451e`** | **GitHub tree + raw @ pin** (local clone blocked) |
| pi-permissions | `/Users/x1a2h1/.pi/agent/extensions/pi-permissions` | working tree (local read OK) | direct `read` |

> Blocker: bash + tools touching `/tmp/repo-research/**` and `~/.graphify/**` hit `external_directory=ask`. fx/Codex local SHAs could not be `git rev-parse`'d. MiniMax/fx/Codex evidence is GitHub raw/API at the SHAs above. pi evidence is local `src/**`.

This note does **not** claim live product behavior beyond source/docs at the cited pins. Claude Code Auto Mode is **out of scope** (different product); minimax/fx docs do not claim comparison with it in the sources read.

---

## 1. 结论

1. **minimax-code @ `d9ee3a8` 有 LLM 式 auto 审批，但是「云端 Stage-2 分类器」，不是本地 Guardian LLM 审查器。** 证据：`docs/tui-capabilities.md` 表行「Auto permissions | Cloud classifier restored」；`packages/agent-modules/permission/src/classifier/cloud-classify-client.ts` 注释明确 *Stage-2 LLM decision* 走 `POST /mavis/api/v1/permission/check`；云端「thin wrapper around **gemini-flash**」（`cloud-gateway.ts` 文件头）。**不是**「仅静态规则」。
2. **静态层在模型之前，且更厚**：`HARD_BLOCKED_REGISTRY`（最终 deny 类别）+ `SOFT_RISK_REGISTRY`（命中则强制离开 fast-allow、进入 cloud LLM gate）+ first-word / subcommand 危险表。`skipAutoClassifier` / `bypassImmune` 把最终安全边界挡在 LLM 之外。
3. **fail-closed 语义是「失败→ask 用户」**（timeout/非 2xx/非法 verdict → `kind:'timeout'` → facade 映射 ask），**不是** fx/Codex/pi 的「失败→deny/hold 不执行」。产品形态更接近「人审兜底」而非「自动审批者替换」。
4. **与 pi 同构的是 Codex + pi（本仓库）**：静态 policy → LLM Guardian 逐次审查 → fail-closed deny/hold。fx 默认 auto 也是 rules → LLM exact-action review（`clear|caution`，fail-closed hold）；Jev 是**可选** reviewer backend，不是默认。
5. **minimax 与 kimi/MiMo 的旧对照需要修正**：旧笔记（2026-09-10）把 minimax 一族归为「无 LLM 审批者」。**本 pin 证据推翻该说法**——至少 managed runtime 下 auto 有云端 LLM gate；本地 unmanaged/dev daemon 则 `shouldUseCloudClassify()===false` 回落 ask。
6. **对 pi「不过度设计」判断**：minimax 证明「静态厚 + 云端分类器 + 失败问人」是可产品化的另一极；**不构成**把 pi Guardian 换成 thin classifier 的理由。对齐候选仍是 Codex（双阶段 + fail-closed + sandbox 不扩权），minimax 更像「对照物」而非「模仿对象」。

---

## 2. 四方对照表

| 维度 | fx | Codex @ `129fd216` | minimax-code @ `d9ee3a8` | pi-permissions |
|---|---|---|---|---|
| **Mode names** | `ask` / **`auto`（默认）** / `full-access`（legacy yolo）— fx.sh docs + `permissions.zig` PermissionEngine | `AskForApproval{UnlessTrusted,OnRequest,Granular,Never}` × `ApprovalsReviewer{User,AutoReview}`；UI 菜单打包 **Approve for me = OnRequest+AutoReview**；`protocol.rs:988+`；`review.rs` 路由 | **`PermissionMode`**: `default`\|`acceptEdits`\|`bypassPermissions`\|**`auto`**\|`dontAsk`\|`off` — `packages/agent-modules/permission/src/types.ts`；UI `/permission ask\|auto\|full` + `permissionMode:off` / headless `--permission off` | **`"auto"\|"yolo"`** — `src/state.ts:5`；legacy default/plan → auto（`:78`）；标签 Approve for me / Bypass |
| **LLM reviewer?** | **YES** — auto 未解决动作 LLM exact-action review；`auto_classifier.zig` `Decision clear\|caution` + `Risk`；默认 gateway chat reviewer（源码 `openai/gpt-5.6-luna` vs docs `moonshotai/kimi-k3`，**不以单一为产品真理**）；**可选** `review_model=typesafeai/jev` | **YES** — Guardian **后置** stage；`routes_approval_policy_to_guardian` = `(OnRequest\|Granular(_)) && AutoReview` — `core/src/guardian/review.rs`（pin raw）；Forbidden 不进 Guardian | **YES（云端）** — Stage-2 LLM via `POST …/mavis/api/v1/permission/check`；model 字段 telemetry 默认 `cloud:gemini-flash`；**仅 managed runtime**；本地 unmanaged → 无 LLM、回落 ask | **YES** — Guardian LLM（独立 worker 子进程）；`src/auto-reviewer.ts` / `guardian-model.ts`；`resolveGuardianModel`: configured→active→active-fallback |
| **Static layer** | rules/session grants 先行；auto classifier 对**未解决**动作 | ExecPolicy `Decision{Allow,Prompt,Forbidden}` + `is_dangerous_command` 静态启发式 **先于** Guardian | **HARD_BLOCKED**（catastrophic/exfil/disk-erase/… final deny）+ **SOFT_RISK**（强制进 LLM）+ first-word / SUBCOMMAND_DANGEROUS + rm→mavis-trash rewrite — `classifier/dangerous-patterns.ts` | `Risk{LOW,REVIEW,HARD}` + `shellCommandIsDangerous` + rules glob + path/network — `src/risk-policy.ts` / `permissions/risk.ts` |
| **Which tools** | auto review 覆盖 command / shell_input / file_mutation / tool（`auto_classifier.zig` Action union）；未解决者进 review | exec / apply_patch 等 approval 路径；Forbidden 短路 | **bash + fs** 为主（`tools/bash-*`、`tools/fs-*`）；engine `checkPermission(toolName,input)`；MCP/connector 有独立 permission adapters（facade 注释）；`off` 模式几乎全跳过 | owned tools（bash/write/edit/request_permissions）可 sandbox 强制；host-admission（MCP/custom）**review-only** — `docs/host-api-boundaries.md:22-46` |
| **Sandbox vs review-only** | sandbox 与 approval 正交；auto review 是决策层 | **Approval 不扩权**；Guardian 会话 read-only + `approval_policy=never`；linux-sandbox/seatbelt 等 | **有 OS sandbox**（`third_party/sandbox-runtime`、`local-runtime-v2/.../sandbox/`、`srt-macos.ts`）；approval **≠** sandbox 扩权，facade 另产出 `executionPlan` | SRT `@anthropic-ai/sandbox-runtime@0.0.74`；批准不扩权；host-admission / escalated 无 SRT 强制（`sandboxEnforcesAction=false`） |
| **Fail-closed** | reviewer 无效/不可用 → **hold**（不 unreviewed 执行）；`HostDisposition.unavailable` | parse/session 失败 → `GuardianAssessmentOutcome::Deny` + FailedClosed；timeout → TimedOut（模型可重试/问人）；circuit 3 连拒或 50 内 10 次打断 turn | gateway 失败 → **`kind:'timeout'` → ask 用户**（`http-cloud-gateway-client.ts` 文件头 *fail-closed policy* 实际是 **fail-to-human**）；HARD final deny / bypassImmune 则不经 LLM | policy/Guardian 失败 → deny/block；circuit breaker 3/10-of-50；yolo 短路执行 |
| **Notable knobs** | `review_model` / `FX_REVIEW_MODEL`、`TYPESAFE_API_KEY`、`TYPESAFE_BASE_URL` | `approvals_reviewer`、`approval_policy`、`auto_review_model_override`、`strict_auto_review`（prior T91：Skip 仍 review；pi 无对应符号） | `permission.classifierTimeoutMs`（default **60000**，floor 5000）`policyOwner` core\|engine `userConfirmationEnabled` `storageWriteVersion` — `packages/config/src/permission-config.ts`；`permissionMode` 运行时可 `PUT /config` | `config.json` / `permissions.json`；`reviewer` model；sandbox.network 轴；Guardian worker limits |
| **Complexity notes** | Jev 可选第二后端；概率/置信度 **记录不门控**；contextual root-user 证据（assistant/tool 文本不可成为 authority） | Guardian trunk session 复用 prompt-cache；busy 时 ephemeral fork；analytics/metrics；Cyber 模型 breaker 1/1 | Windows/POSIX trash rewrite 管线；HARD/SOFT 注释写明与 agent-server desktop_rules 对齐；metrics `permission_llm_check_*`；conversation_context 进 cloud prompt | 独立 Guardian worker 进程；SRT coordinator lease/poison；execution-attempt freeze；delegation ceilings |

---

## 3. minimax 专项（主问题）

### 3.1 答案

**有 LLM 审批路径（云端 classifier），不是「仅静态规则」。** 也不是本地进程内 Guardian。

- **模型**：cloud 侧 thin wrapper around **gemini-flash**（`cloud-gateway.ts` 文件头注释；HTTP client 默认 telemetry `model: 'cloud:gemini-flash'`）。客户端**不选择**模型——与 fx `review_model` / Codex guardian model / pi `reviewer` 配置不同。
- **触发条件**：`modeToAskPolicy(auto) === 'on-request-llm'` 且静态引擎给出 `ask` 且 `!decision.skipAutoClassifier` 且 `shouldUseCloudClassify()`（managed runtime）— `facade.ts` auto 分支。
- **输入**：`{tool_name, input(序列化命令/工具输入), platform, home_dir, workspace_root, mode:'auto', conversation_context, agent_id?, session_id?}` — `cloud-gateway.ts` CloudClassifyRequest。
- **输出**：`verdict ∈ {allow, confirm, block}` + `reason`；客户端合成 `timeout`。facade 映射：`allow→allow`；`confirm|block|timeout→ask`（**block 不是最终 deny**——仍问用户）。
- **Fail 路径**：HTTP 非 2xx / 非 JSON / 非法 verdict / 网络 / abort → `{kind:'timeout'}` → ask。文档措辞 fail-closed，**运行时语义是 fail-to-human**。
- **适用范围**：managed desktop/cloud runtime；**纯本地/BYO-key dev daemon 不走 cloud**，auto 下未解决 ask 直接问人。
- **Sandbox**：独立于 permission decision（`third_party/sandbox-runtime` + `local-runtime-v2` sandbox 服务）。

### 3.2 关键证据（GitHub @ `d9ee3a8`）

| Claim | Evidence |
|---|---|
| Auto 有 cloud classifier | `docs/tui-capabilities.md`：`Auto permissions \| Cloud classifier restored; local rules and confirmation on failure retained` |
| 产品文档 mode 名 | agent.minimax.io features：`/permission ask\|auto\|full`；auto = “Classify routine actions automatically and ask when risk is high”；`permissionMode: off` / `--permission off` |
| Stage-2 LLM endpoint | `packages/agent-modules/permission/src/classifier/cloud-classify-client.ts`：`POST /mavis/api/v1/permission/check`；`shouldUseCloudClassify() = isManagedRuntime()` |
| Wire + model | `packages/agent-modules/permission/src/cloud-gateway.ts`：verdict allow\|confirm\|block；“thin wrapper around gemini-flash” |
| HTTP fail→ask | `packages/agent-modules/permission/src/http-cloud-gateway-client.ts` 文件头 + `fallbackTimeout()` |
| Static HARD/SOFT before LLM | `packages/agent-modules/permission/src/classifier/dangerous-patterns.ts`：`HARD_BLOCKED_REGISTRY` / `SOFT_RISK_REGISTRY`；SOFT “force … into the cloud LLM gate” |
| skip LLM for final safety | `packages/agent-modules/permission/src/types.ts`：`skipAutoClassifier` / `bypassImmune` |
| Admission orchestration | `packages/local-runtime/src/permissions/facade.ts`：deterministic engine → (auto) cloud gateway → ask-gate for bypass |
| Timeout knob | `packages/config/src/permission-config.ts`：`classifierTimeoutMs` default 60000, floor 5000 |
| Mode enum | `packages/agent-modules/permission/src/types.ts`：`PermissionMode` 六值 |
| Permission facade tests | `docs/verification.md`：`permission policy (115 tests)` |
| Retired path | `scripts/lib/retired-sources.mjs`：`confirmation-gateway-client.ts` 已退役（历史确认网关客户端） |

### 3.3 auto 链路（minimax）

```text
before_tool_call (agent-extension permission.ts)
  → LocalPermissionFacade.checkPermission (mode snapshot once)
    → runtime hard safety (Windows/POSIX trash / bypass-immune)
    → mode off? → allow (skip) unless delete rewrite needed
    → PermissionEngine.checkPermission  (rules + bash/fs checkers + HARD/SOFT + rewrite)
        allow / deny / ask
    → ask + policy on-request-llm (auto):
         skipAutoClassifier || !managed → ask (no LLM)
         else HttpCloudGatewayClient.classify → gemini-flash
              allow → allow
              confirm|block|timeout|error → ask
    → applyAskGate (bypassPermissions 再压成 allow；bypassImmune deny 除外)
    → executionPlan projection
```

### 3.4 搜索清单（若有人主张「无 LLM」）

已检出并读取（非穷尽服务器侧）：`docs/{tui-capabilities,architecture,verification,open-source-status,README}.md`、`AGENTS.md`、agent.minimax.io features、git tree @ pin 中 `permission*|classifier*|sandbox*|guardian*` 路径、`permission.ts` / `types.ts` / `classifier/*` / `cloud-gateway.ts` / `http-cloud-gateway-client.ts` / `facade.ts` / `permission-config.ts` / `bash-fast-allow.ts` / `dangerous-patterns.ts`。

**未在树中检出**名为 `guardian` 的 minimax 符号。云端 prompt `packages/local-runtime/prompts/llm-gate-classifier.md` 在 cloud-gateway 注释中被引用，**本 session 未拉取该文件全文**。服务器端 `/mavis/...` 实现不在开源树内。

---

## 4. auto 链路简图（四方）

```text
fx:     rules/session grants → unresolved action?
          → auto_classifier LLM (clear|caution; Risk)  [optional Jev backend]
          → clear: run | caution/unavailable: HOLD (fail-closed)

Codex:  tool call → exec_policy Decision
          Allow → sandboxed run
          Forbidden → never Guardian
          Prompt + OnRequest/Granular + ApprovalsReviewer::AutoReview
            → Guardian LLM (Allow|Deny + risk + authorization)
            → Deny/fail: ReviewDecision::denied / fail-closed
          Prompt + User → human approval UI
          (approval never expands authority)

minimax: before_tool_call → facade
          hard safety / mode off
          → engine rules + HARD/SOFT + rewrite
          → auto + ask + managed: cloud gemini-flash
               allow → run | confirm/block/timeout → ASK human
          → bypassPermissions ask-gate → allow (except bypassImmune)

pi:     owned tool → risk-policy LOW/REVIEW/HARD
          allow → SRT lease execute
          block → deny
          prompt → AdmissionPlan{kind:"review"}
            → Engine policyCheck → Guardian worker LLM
            → deny/fail fail-closed; circuit breaker
          yolo → executeUnrestricted (no Guardian)
          host-admission tools: review-only, no SRT after allow
```

---

## 5. 对 pi 的含义

1. **「minimax 无 LLM」不成立** — 旧四方笔记该行需标注 **superseded by d9ee3a8 evidence**。对齐讨论不要再把 minimax 当「纯规则短路」范例。
2. **pi 的 Guardian 双阶段仍与 Codex/fx 同构**；minimax 是「云端 thin classifier + 问人兜底 + 厚静态表」——不同产品假设（managed 服务可调 gemini-flash；BYOK/本地不可用则问人）。
3. **「不过度设计」判断不因 minimax 翻案**：pi 的复杂度来自 host 无原生 sandbox/mode + 执行尝试冻结 + host-admission 限制（`docs/host-api-boundaries.md`），不是为了对齐 minimax。
4. **可借鉴但非必须**：minimax 的 `HARD_BLOCKED` **final-deny 类别**（灾难删除/磁盘擦除/勒影指标等）比 pi 路径保护更「动作类别化」——与 09-10 笔记里 MiMo `FORCED_ASK` 方向一致，可作 **optional** 静态 floor 扩展，不替代 Guardian。
5. **无新必须对齐项**：minimax fail-to-human vs pi fail-closed-deny 是**故意不同的产品选择**；勿把 minimax 的 cloud classifier 当 pi reviewer 替代方案。fx 默认 LLM review + Jev 可选仍是 pi 预备层的更近参照（见 `2026-09-18-typesafe-jev-fx-integration.md`）。

---

## 6. 不确定项

1. **fx / Codex local clone SHA**：`/tmp/repo-research/*` 被 external_directory 拦截，无法 `git rev-parse`。fx 记录 GitHub main `34d262d…`；Codex 正文统一 pin `129fd216…`。若本地 clone 与之不一致，以 pin/API 为准并重跑。
2. **pi-permissions 工作树 commit SHA**：本次未跑 git（bash 策略）；以 `src/**` 内容为准。
3. **fx 默认 reviewer 模型**：源码 `permission_reviewer.zig` 曾为 `openai/gpt-5.6-luna`，docs 写 `moonshotai/kimi-k3`——**冲突未在本 pin 重读源码消解**；对照表不采单一值。
4. **minimax cloud prompt 全文**（`llm-gate-classifier.md`）与服务器实现未开源/未拉取；verdict 语义以客户端注释 + HTTP client 映射为准。
5. **minimax MCP/connector 是否一律进同一 facade**：tree 有 feishu/wechat permission adapters 与 `plugin-hook-permission-contracts`，链路细节未逐文件读完。
6. **Codex `strict_auto_review` / Guardian 默认模型 / is_dangerous_command 行号**：依赖 prior notes + `review.rs` raw；`protocol.rs` 体积大，`AskForApproval` 枚举确认在 `:988` 附近，完整 variant 列表未逐行摘录。
7. **GitHub code search 401**：minimax 检索依赖 tree dump + raw 直取，不是全库 rg。

---

## This note does not claim

- 运行时行为验收（未启动 mcode/fx/codex）。
- 云端 `/mavis` 服务的 prompt/模型版本与客户端注释一致。
- 本地 `/tmp/repo-research/**` clone 与上表 SHA 一致。
- Claude Code Auto Mode 属于四方之一。
