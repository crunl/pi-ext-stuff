# Tool call 单轮耗时：Codex pin 对照 + pi-permissions 优化路径

## Scope

- Date: 2026-09-17
- Codex pin: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- Host pin: `@earendil-works/pi-coding-agent@0.85.1`
- Pi tree: this repo @ `7956a74` (metrics landed; working tree may have untracked research notes)
- Question: how to reduce **one tool-call turn** latency on the auto/Guardian path
- This note is research only — no product code change claimed

## 1. Where time goes (pi critical path)

For auto-mode bash that is **not** statically LOW:

```text
captureAction
  → preparePermissionExecution (config/mode/snapshot)
  → evaluateRiskRequest / hostRiskEvaluator   [process]
  → admissionPlanFromRiskDecision             [process]
  → Engine runReview                          [if reviewRequested ∪ forced]
       → resolveGuardianModel + getApiKeyAndHeaders
       → sessions.open (trunk/delta decision)
       → complete() Guardian LLM              ← dominant RTT
       → (optional) tool rounds → worker spawn + SRT in child
       → parse + floor + commit trunk
  → mint one-shot grant (if approve)
  → host SRT execute                          [amortized singleton]
```

Evidence:

| Stage | Location | Cost class |
|---|---|---|
| Risk/policy | `src/risk-policy.ts` `evaluateRiskRequest` | process, small |
| Skip LLM when LOW | `risk-policy.ts:332-336` non-dangerous sandboxed bash → LOW | free path |
| Skip LLM when grant covers | `approve-for-me-engine.ts:2157-2203` filters `reviewRequested` by baseline | free when covered |
| LLM review | `auto-reviewer.ts:375+` `complete` + `cacheRetention:"short"` + `sessionId` | **dominant** |
| Delta prompt | `guardian-session.ts:207-236` trunk + cursor | reduces input tokens |
| Cache key | `guardian-session.ts:194-196` `pi-permissions-guardian-${sessionId}` | provider prefix hit |
| Evidence worker | `guardian-worker-client.ts:507` spawn on **first** `execute` | only if tools used |
| Tool rounds | `auto-reviewer.ts:430` cap 8; `executeToolCalls` **serial** | multiplies RTT |
| Reasoning default | `auto-reviewer.ts:68` `DEFAULT_REVIEW_REASONING = "medium"` | medium vs Low |
| Budgets | `guardian-transcript.ts:17-18` 10k **chars** / entry class | not token-based |

Metrics now emit `durationMs` on terminal review events (`register.ts:217-257` → `{agentDir}/guardian-metrics.jsonl`) but there is still no live e2e file on this machine — no production latency distribution yet.

## 2. Codex critical path at pin (summary)

**In-process dual path**, not per-review process spawn.

| Path | When | Latency shape |
|---|---|---|
| Sync Guardian reviewer | default for shell under `computer_use_only=true` | full LLM assessment, trunk session reuse, delta transcript, cache key `guardian:{parent_thread_id}` |
| Async Luna scorer | Adaptive categories (often computer_use, not default bash) | tool-less classifier, first-token high/low, score cache with lag≤2 |

Sync bash serial chain (Codex):

```text
execpolicy (Allow→Skip / Prompt→NeedsApproval / Forbidden)
  → hooks
  → decide_approval (in-process thread)
  → cached_evidence (usually skipped for default shell)
  → trunk lock / session reuse
  → prompt Full|Delta (approx-token budgets)
  → Guardian LLM (prefer ReasoningEffort::Low)
  → parse GuardianAssessment
  → sandbox transform
  → exec
```

Codex does **not** parallelize approval with sandbox, and does **not** speculative-exec.

## 3. Codex optimizations that exist (transferability)

| Technique | Exists at pin? | pi status | Transfer |
|---|---|---|---|
| Pre-LLM policy ladder (rules allow / Forbidden / full_access / session cache) | yes | partial (yolo, LOW, turn grants, circuit) | **extend ladder** |
| Session `ApprovedForSession` cache | yes | turn-only grants by design | product decision |
| Delta transcript cursor | yes | **done** `ecd6fdb` | done |
| Stable prompt cache key per parent session | yes | **done** | done |
| approx-token layered truncation | yes (4 B/token, prefix+suffix) | char budgets only | **copy** |
| Prefer Low reasoning on reviewer | yes | default medium | **copy** |
| Background classifier + lag-window reuse | yes (Luna) | none | optional path |
| Previous reviews as **evidence only** (not auth) | yes | none | optional |
| In-process trunk / WS pool | yes | evidence worker per review (lazy) | path 1 residency |
| Approval ∥ sandbox preflight | **no** | no | n/a |
| Speculative execution | **no** | no | n/a |

Important correction to naive reads: **Codex default bash still hits sync LLM** when approval is required. Luna fast-path is not free for shell under legacy `computer_use_only=true`. The high-frequency win is still “don’t enter LLM at all”, not “make LLM slightly faster”.

## 4. Ranked work for pi (single-turn latency)

### P0 — cut LLM invocations (largest absolute win)

| Item | Why | Sketch |
|---|---|---|
| **A. Measure first** | no live `guardian-metrics.jsonl` yet | one live auto review → read `duration_ms` / `session_kind` / token_usage; optional `check:guardian-metrics` offline sink test later |
| **B. Expand no-LLM ladder without opening authority** | Codex rule-allow / session-cache style | inventory every `action:"prompt"` source; keep HARD/dangerous as review; ensure turn grants already suppress duplicate capability reviews (engine already filters); consider **same-turn exact action fingerprint** reuse only for non-host-owned, non-escalated, non-dangerous sandboxed bash already approved once this turn — fail-closed on any input drift |
| **C. Do not treat trusted/previous reviews as authorization** | Codex explicit | if we add evidence, keep it non-authorizing |

### P1 — cut LLM latency when review is required

| Item | Why | Sketch |
|---|---|---|
| **D. Reviewer reasoning default → Low** | Codex prefers Low; medium inflates TTFT/tokens | `DEFAULT_REVIEW_REASONING` + config default; keep high only if user sets it |
| **E. Token-shaped budgets** | Codex approx 4 B/token layered caps | replace/align `MAX_*_CHARACTERS` with layered approx-token budgets + prefix/suffix marker; keep raw log unbounded for Delta cursor |
| **F. Ensure Delta+cache actually apply** | fork busy / epoch change → Full | reduce forced Full cases; keep fork isolation; metrics already have `session_kind` |

### P2 — cut cost when Guardian uses tools

| Item | Why | Sketch |
|---|---|---|
| **G. Worker residency / warm pool (path 1)** | spawn+bootstrap+SRT-in-child only on tool use today | session_start warm idle worker; reuse across reviews with authority fingerprint checks; still never share host SRT |
| **H. Parallel tool results** | `executeToolCalls` serial | parallelize independent read-only calls under one deadline |
| **I. Tighter tool policy in prompt** | multi-round LLM is expensive | keep “prefer transcript; tools only if decision flips” (already in policy); consider lowering max rounds when evidence is already in prompt |

### Not recommended to copy

- Luna WS connection pool / first-token drain (provider-bound)
- OTel closed-loop routing (host has no OTel)
- Expanding session-scoped grants without an explicit product decision (`docs/host-api-boundaries.md`)
- Making previous Guardian approvals a silent auth cache

## 5. Expected impact (qualitative)

| Change | When it helps | Order of magnitude |
|---|---|---|
| Skip LLM (grants/ladder) | repeated similar capabilities in one turn | removes entire LLM RTT |
| Low reasoning | every required review | tens of % on generation time (model-dependent) |
| Delta + cache (already done) | sequential reviews same trunk | large on **input** tokens / cache hit TTFT |
| Token budgets + truncation | long transcripts | large on input tokens |
| Worker residency | reviews that call read tools | saves spawn+SRT cold start per review |
| Parallel tools | multi-tool Guardian rounds | modest |

## 6. Concrete next slice (if implementing)

Smallest high-value slice after measurement:

1. Live smoke: one auto bash review → confirm `guardian-metrics.jsonl` `duration_ms`.
2. Config/docs: `reviewer.reasoningEffort` default narrative → Low; code default change is a product call.
3. Tests: engine already skips review when `requestCovered(baseline, …)`; pin any **new** same-turn fingerprint reuse with hermetic tests that input drift forces review.
4. Optional named check later for metrics sink (user deferred e2e earlier).

## This note does not claim

- Live latency numbers on this machine (no metrics file yet).
- Codex model-catalog overrides that might set `model.guardian.shell=Adaptive` (would enable Luna on bash).
- That path 1 worker residency is scheduled — it remains deferred pending measurement.
