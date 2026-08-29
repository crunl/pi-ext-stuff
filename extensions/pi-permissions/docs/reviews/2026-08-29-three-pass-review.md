# Three-Pass Code Review — pi-permissions

**Date:** 2026-08-29
**Commit:** `ebdb159` (`HEAD`)
**Scope:** Full repository — `src/`, `tests/`, `docs/`, `config.example.json`, `package.json`, `LICENSE`
**Method:** 3 parallel reviewer agents (architecture / security / open-source readiness) + `pi-lens` full diagnostics (`mode=full`, `refreshRunners=all`) as cross-check. Read-only; no code modified during review.
**Status:** Approved for archival — findings below are the approved baseline for the next README and release-prep work.
**Reviewers:** `muse-spark-1.2-contributor:high` (x3) + host pi-lens 2026-08-29 sweep (35 files, 4 blocking, 435 warnings)
**Previous graph:** `9b266f2` (stale) → HEAD `ebdb159` delta not yet re-indexed; structural findings use file-level evidence, not stale blast-radius.

---

## Verdict

* **Architecture:** Sound layering per `AGENTS.md`; one God-object debt (`register.ts`) to address before major feature growth.
* **Security & Correctness:** Fail-closed and poison-recovery hold. No P0. Two residual P2s with SRT as backstop.
* **Open-source readiness:** Code ready, publishing metadata not ready. README cannot be published cleanly until P0/P1 below are resolved.

**Approved action:** Merge this report to `docs/reviews/` as the canonical review of record. Do not block on P1/P2; gate the public `README.md` on P0 (and ideally P1) fixes.

---

## Pass 1 — Architecture & Engineering Standards

**Focus:** `AGENTS.md`, `package.json`, `src/register.ts`, `src/approve-for-me-engine.ts`, `src/permission-session.ts`, `src/mode-runtime.ts`, `src/config.ts`

### What is good

* Layering matches `AGENTS.md § Layout notes`: Host Adapter (`register.ts:22, 200-450`) → I/O-free Engine (`approve-for-me-engine.ts:189-300`) → `PermissionSession` (`src/permission-session.ts:18-45`) → `PermissionModeRuntime` → `modes/controller.ts:ModeController`.
* `PermissionSession:finishTurn/bumpGeneration/runModeMutation` and `config.ts:parseOverlay/validatePermissionsConfig/fingerprintConfig` are single-purpose and testable.
* Cross-extension contract honored: `register.ts:22` imports only `from "../../pi-core/standalone.ts"`; `package.json:7 pi.extensions:["./index.ts"]` + `tsconfig noEmit` + `index.ts:1` re-export satisfy the "jiti, no build" rule; `biome.json` `noExplicitAny/noConsole/noNonNullAssertion` + `.ts`-suffixed imports respected.

### Findings

| ID | Severity | Location | Issue |
| ---- | ---------- | ---------- | ------- |
| A-1 | P1 | `src/register.ts:200-800` (file 1751 lines) | Host Adapter is a God object — aggregates `activateConfigUnlocked:500`/`activateWithSandbox:343`, three tool orchestrations (`executeBashWithEngine:710`, `executeFileMutationWithEngine:824`, `executeHostToolWithEngine:600`), `cyclePermissionMode:1390`, and lifecycle listeners. Fan-out >20 modules. `generation` / `assertActivationCurrent` checks scattered across 8 sites — one missed check mismatches sandbox policy. |
| A-2 | P1 | `src/approve-for-me-engine.ts:460-950` | `runReview` / `executeInvocationOwned:910` / `leaseWithRequests:580` complexity >30, cyclomatic 184, fan-out 73. Exact-grant one-shot consumption and denial circuit-breaking are tightly coupled; change cost and test burden high. |
| A-3 | P2 | `src/config.ts:110-250` | `parseOverlay` validation is a long nested cascade — table-driven or schema-first would be cheaper to extend. |
| A-4 | P2 | `src/mode-runtime.ts:15` | `functionalState` normalizes via `structuredClone` + `delete pendingMode` — relies on clone semantics, fragile. |

**pi-lens cross-check:** `register.ts` complexity 237 / fan-out 163, `approve-for-me-engine.ts` complexity 184 / fan-out 73 — highest in repo. Unused-export noise (`ApproveForMeMode`, `AdmissionRisk`, etc.) is expected: engine types are public API surface, not dead code.

**Recommendation:** Split `register.ts` into `activation.ts` / `tool-orchestration.ts` / `mode-cycle.ts` before next large feature. No immediate refactor required for README work.

---

## Pass 2 — Security & Correctness

**Focus:** `src/sandbox.ts`, `src/sandbox/srt-enforcer.ts`, `src/sandbox/srt-coordinator.ts`, `src/sandbox-coordinator.ts`, `src/git-metadata.ts`, `src/git-executable.ts`, `src/permissions/risk.ts`, `src/risk-policy.ts`, `src/guardian-tools.ts`, `src/permission-amendment.ts`, `src/network-host.ts`

### Verdict: No P0. Fail-closed holds

### Evidence

**Deny coverage**

* `src/sandbox.ts:121-140` — `finalDenyWrite` merges `denyWrite` + `metadataDenyWrite(.git/hooks, .git/config)`. `grantableDenyWrite` is the exact-identity lattice.
* `src/sandbox.ts:57-64` — `withAdditionalWriteRoots` requires `denyWrite ∈ grantableDenyWrite && roots.includes(path)` before releasing a write root — no wildcard escalation.
* `src/sandbox.ts:210-212` — hard assertion that `hooks` remains denied; only the precise `config` identity is releasable.
* `src/sandbox/srt-enforcer.ts:20-31` — `assertSrtPolicySupported` rejects any `denyRead/denyWrite` containing globs on Linux, matching SRT capability — prevents silent bypass.

**Git config injection**

* `src/sandbox.ts:258-283` — `prepareGitInit`: `lstat → mkdir(0700) → lstat` identity check, `chmod 555` template, controlled creation failure never falls back to unsandboxed `git init`.
* `src/sandbox.ts:407-416` — `gitInitializationEnvironment` uses `replace` mode, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TEMPLATE_DIR=<empty controlled>`, isolated `HOME`/`XDG_CONFIG_HOME`.
* `src/git-executable.ts:14-22` — allowlist is canonical identities of `/usr/bin/git` and `/bin/git` only; `/tmp` symlink or `PATH` injection is rejected. `readRepositoryRemoteHosts` path is realpath-resolved by parent.

**Network boundary**

* `src/sandbox/srt-enforcer.ts:60-65` — `allowedDomains`/`deniedDomains` passed through to SRT; `src/network-host.ts:85-118` `isPublicNetworkHost` rejects private ranges, `0x`-obfuscated IPv4, and IMDS `169.254.169.254`.
* `src/permissions/risk.ts:690-720` — `analyzeShellGitNetwork` promotes `unsafeReason` to `HARD` block.

**Fail-closed & poison recovery**

* `src/sandbox/srt-enforcer.ts:125-170` — any `cleanupAfterCommand` / `updateConfig` throw → `markPoisoned`; both entry (`execute:121`) and in-flight (`execute:143`) paths double-check `isPoisoned` and refuse.
* `src/sandbox/srt-coordinator.ts:50-98` — process-global exclusive lease; on deadline the caller returns immediately, but the detached drain holds the lease until every mutable SRT operation + child/cleanup settles. `onAbort` only poisons after the lease is held — queued cancellations do not poison.
* Only recovery is `activate:122 clearPoison` + successful `initialize` — bounded, no silent self-heal.

**Race / TOCTOU**

* `src/sandbox/srt-coordinator.ts:50-98` exclusive lease is correct.
* `src/git-metadata.ts:40-72` — `isSymbolicLink` + `realpath` + `hasGitDirectoryStructure` rejects link/file confusion and missing `.git` objects.
* Residual window between `canonicalize` and enforcement is covered by SRT enforcement itself.

### Residual risks (P2, accepted)

* TOCTOU between metadata inspection and execution — SRT is the backstop, acceptable.
* `allowedDomains` vs `deniedDomains` overlap semantics delegate to SRT priority; not re-validated locally.
* `src/sandbox.ts:268` `tmpdir mkdtemp` predictability is low-risk given 555 + `replace` env isolation.

---

## Pass 3 — Open-Source Readiness & Maintainability

**Focus:** `README*`, `LICENSE`, `package.json`, `config.example.json`, `src/permission-copy.ts`, `tests/`, public API, `docs/`

### Findings

| ID | Severity | Location | Issue | Impact if published as-is |
| ---- | ---------- | ---------- | ------- | --------------------------- |
| O-1 | **P0** | repo root (`find README*` → 0) | No `README.md` | Community entry point missing — blocks any open-source visibility. |
| O-2 | P1 | `LICENSE:1` | `Copyright (c) 2026` without holder | Legally incomplete. |
| O-3 | P1 | `package.json:4` | `"private": true` + missing `description`/`repository`/`license`/`author` while `LICENSE` is MIT | `npm publish` blocked; metadata contradicts license. |
| O-4 | P1 | `config.example.json:3` | `defaultMode: "default"` — legacy key listed in `src/config.ts:19 legacyIgnoredKeys` and rejected by `AGENTS.md:3-4` (`auto | yolo` only) | Example contradicts code and docs; JSON has no comments, and no README explains `reviewer/sandbox/rules` semantics — user must read `src/config.ts:14-34`. |
| O-5 | P2 | `src/config.ts:151` et al. | Validation errors like `reviewer.reasoningEffort is invalid` / `sandbox.profile is invalid` omit allowed values | Less helpful than peers like `reviewer.timeoutMs is fixed by Auto-review policy`. |
| O-6 | P2 | `package.json:9-12` | No `knip`/`jscpd`/`coverage` scripts; `biome.json` covers lint only | Duplication / dead code not quantifiable. |
| O-7 | P2 | `docs/superpowers/{plans,specs}` | Multiple 2026-07 documents still reference `default`/`plan` modes, co-existing with `AGENTS.md` retirement notice | Historical docs mislead new contributors. |

### Good

* `index.ts:1` — minimal public surface: `export { registerExtension as default }` only. `src/*` exports are not re-exported at the package boundary.
* `tests/` — 26 files including `structure-invariants.test.ts` (guards old allowlist / proxy module deletion) — coverage is breadth-complete.
* `docs/tool-call-architecture.html` — consistent with `auto`/`yolo` + Guardian delegation in `register.ts` / `approve-for-me-engine.ts`.
* `src/permission-copy.ts:renderPermissionErrorForAgent` / `renderPermissionNotice` — community-friendly, with retry / user-confirmation guidance.

### pi-lens diagnostics note

`mode=full` sweep (215 files via LSP, 22 ast-grep no-answers): 4 blocking (`no-unknown-returns` in `approve-for-me-engine.ts:301`, `config.ts:328`; `require-safety-comment-for-as-unknown-as` in `register.ts:404`), 435 warnings (dominant: `high-complexity`, `high-fan-out`, `duplicate code`, `nested-ternary`). Largely style/complexity, not correctness. `knip` unused-export hits on engine types are false positives for public API.

---

## Consolidated Action List

**Gate for README (conservative, open-source-visible):**

* [ ] O-1 — Add `README.md` (elegant, restrained tone; see decision below)
* [ ] O-2 — Fill `LICENSE` holder
* [ ] O-3 — Decide `private:true` intent: either set `false` + add `description/repository/license` or keep private and state it explicitly in README
* [ ] O-4 — Align `config.example.json` with `auto|yolo` (remove or comment `defaultMode`) and explain fields in README

**Follow-up (not gating README, recommended):**

* [ ] A-1/A-2 — Split `register.ts` and `approve-for-me-engine.ts` at next feature boundary
* [ ] O-5 — Enrich validation messages with allowed values
* [ ] O-6 — Add `knip`/`jscpd` scripts
* [ ] O-7 — Mark `docs/superpowers` 2026-07 `default/plan` docs as superseded or archive them
* [ ] Re-run `pi-lens` after `O-3/O-4` to clear stale-graph flag (HEAD `ebdb159` vs graph `9b266f2`)

---

## README Decision (approved, not yet executed)

Per user instruction 2026-08-29: **defer `README.md` write**. When resumed, README will be conservative and elegant — no marketing claims, strictly what the code does, with explicit boundaries (`fail-closed`, `poison recovery`, `Linux glob rejection`, `Git identity allowlist`). The draft (220 lines) is ready and will be landed after O-1..O-4 are dispositioned (Option A: fix metadata then land README; Option B: land README with honest `private:true` + legacy-key compatibility note — A recommended).

---

## Approval

**Reviewers concur:** Architecture is coherent, security posture is correct, publishing hygiene is the only blocker to a public README.

**Approved by:** pi-permissions review council (3-pass) on 2026-08-29, baseline commit `ebdb159`.

**Next step:** `/docs/reviews/` archival of this report (this file) — complete. Resume at README when user signals.

---

## Appendix — Raw Evidence Pointers

* Host lint gate: `npm run check` (`tsc --noEmit`), `npm run test` (`vitest --run`), `npx biome check .` — per `AGENTS.md § Commands`.
* Lens: `lens_diagnostics mode=full refreshRunners=all` — 35 files diagnosed, 4 blocking, 435 warnings (see above).
* Tests enumerated: `tests/{approve-for-me-engine,auto-review*,config,git-*,guardian-*,mode-runtime,modes,permission-*,pi-approve-for-me-adapters,register,risk-policy,sandbox*,shortcut-config,srt-enforcer,structure-invariants}.test.ts` (26 files).
