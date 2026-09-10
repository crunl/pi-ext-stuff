# AGENTS.md — pi-permissions

Pi coding-agent extension (`pi.extensions` entry in `package.json`) that adds
permission modes (`auto | yolo` — the human-popup `default`/`plan` modes were
retired; the guardian reviewer now approves on the user's behalf), sandboxed
tool execution, and an external "guardian" reviewer. Loaded directly from
`.ts` by the host's jiti — **no build step**.

## Commands

```bash
npm run check     # tsc --noEmit (type check)
npm run diagnose:guardian # read-only real Guardian worker/SRT diagnostic (bounded JSONL)
npm run test      # vitest --run (one-shot)
npx vitest --run tests/<name>.test.ts   # single test file
```

`diagnose:guardian` uses a deterministic local reviewer stub (no provider or
network request), emits phase plus fixed call/review correlation metadata, and
exits non-zero on Guardian initialization, timeout, poison, or cleanup errors.
JSONL schema v2 reports `failure.stage` and `failure.code` from structured
worker/reviewer errors, never from message text. An unreported worker exit is
`transport/failed`; only an owned deadline is `timeout`.

Biome governs style/lint (`biome.json`) but there is **no `lint` script**; run
`npx biome check .` if needed. Notable strict rules: `noExplicitAny`,
`noConsole`, `noNonNullAssertion` are errors (relaxed only under `tests/**`);
double quotes; imports must use explicit `.ts` extensions.

## Product boundaries

Approve for me runs entirely in this extension; the Pi host has no first-class
permission mode, grant store, or sandbox. Standing Codex pin for alignment
claims is `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`. Host API limits
(owned tools vs host-admission review-only, parallel execute vs attempt
freeze, missing host primitives) are documented in
`docs/host-api-boundaries.md`. Do not schedule work that contradicts that
boundary note without an explicit product decision.

## Cross-extension dependency

- `src/register.ts` imports from `../../pi-core/standalone.ts` (relative to
  `src/`), i.e. the **sibling extension** `extensions/pi-core`. Typecheck and
  tests fail if that checkout is missing.
- Per `pi-core/AGENTS.md`: import only from its `standalone.ts` — never its
  `index.ts` or `src/**` deep paths (index re-registers the extension).

## Tool execution abort guard

The former binary-patch mechanism (core:install/check/test) was retired on
2026-08-26. Abort-race protection is enforced at the extension layer instead:
wrapped tools reject calls whose signal is already aborted at execute entry.
Upstream tracking of the underlying agent-loop race lives in earendil-works/pi.

## Config

Runtime config is read from `<agentDir>/extensions/pi-permissions/config.json`
(this file when deployed at its install path); `config.example.json` shows the
full schema. Config content is fingerprinted into session state, so changes are
tracked per-session. Reviewer provider/model live under `"reviewer"`.

## Layout notes

- `src/register.ts` is the Pi host adapter: it loads config, captures turn
  snapshots, maps host tool events to Engine invocations, and owns the concrete
  bash/write/edit/request-permissions adapters.
- `src/approve-for-me-engine.ts` is the deep, I/O-free decision module. It owns
  admission-plan validation, hard policy checks, Guardian review routing,
  exact one-shot grants, exact command-escalation leases, denial circuit
  breaking, `/approve` retry handles, and turn/session-scoped permission
  amendments.
- `src/pi-approve-for-me-adapters.ts` translates the host's static risk result
  into an `AdmissionPlan` and adapts the Guardian implementation. The Engine
  owns authorization; adapters own only host integration and enforcement.
- `src/permission-session.ts` is the host lifecycle/barrier state machine. It
  tracks generations, turn lifecycle, execution snapshots, and mode mutation
  barriers; it does not own approval or capability state.
- Delegated child scopes are effective intersections of the parent's current
  sandbox policy and the child's requested envelope. Empty configured child
  lists inherit the parent allow set; a resolved empty intersection grants
  nothing. Active delegation ceilings are read from the live nested stack,
  while the audit trail is historical only.
- Sandbox enforcement is backed by the pinned `@anthropic-ai/sandbox-runtime`
  `0.0.74` adapter (`src/sandbox/srt-enforcer.ts`). The public seam is the
  backend-neutral `SandboxManagerLike.execute({ policy, program, cwd, env })`;
  only the adapter serializes argv for SRT's `wrapWithSandboxArgv()` and
  spawns with `shell: false`. `src/sandbox/srt-coordinator.ts` owns one
  exclusive lease per Pi host process. It serializes SRT mutation across every
  registration and ordinary sandboxed tool; the production Guardian does not
  enter this coordinator. Host SRT state lives in `processSandboxState` in
  `src/sandbox/srt-enforcer.ts`, while host draining and persistent fault state
  live on `srtProcessCoordinator`. Execution cancellation or timeout returns
  to the caller immediately, but the detached drain keeps the lease until
  every mutable SRT operation settles and child/cleanup completes. Successful
  cancellation cleanup permits the next execution without clearing a global
  fault or reactivating SRT. Draining is temporarily unhealthy for bare command
  escalation; ordinary sandbox requests wait behind the lease with cancellation
  and deadline handling. A drain deadline never releases an unsettled lease.
  Cleanup, policy-restore, or drain failure poisons the host with its actual
  lifecycle cause, and later executions fail closed.
  Only a successful `SrtSandboxManager.activate()` clears host poison after its
  bounded reset and base-policy initialization. `reset()` (including
  `yolo`/disabled transitions) tears down host SRT/base/connect state but does
  not itself clear the poison latch.
- SRT violation logs are bounded, labelled diagnostics only: available spaces
  are preserved, control characters escaped, and sanitized/unrelated observations
  never select an authorization scope. Authoritative typed capability denials
  remain distinct and do not prove a replay-safe native stage; Bash never replays.
- Native Write/Edit recovery uses attempt-local parent-side operation evidence
  from `createSandboxedFileOperations`, not a parsed denied path. Only access
  failures before content-write entry can trigger fresh Engine review of the
  frozen complete action. Write mkdir recovery adds only its immediate-parent
  subtree, with an explicit partial-directory-effects/re-entry warning; Edit
  access/read recovery requests only the original file write root and preserves
  denyRead. Root/home/Library-wide, ambiguous/glob, already-covered, and
  unsupported scopes fail closed. Linux missing-parent roots are unsupported;
  no existing ancestor is substituted. Any writeFile entry may truncate and is
  terminal. The Engine owns review, policy checks, and at most one SRT retry;
  live delegation ceilings are rechecked for the proposed root and at execution.
  No turn grant or capability-only `/approve` handle is created for this recovery;
  refused reviews still count toward the Auto circuit. A second failure is terminal
  and retains original failure evidence and effects warnings.
- Production Guardian evidence tools run through
  `createIsolatedGuardianToolRuntime()` and `src/guardian-worker.mjs`. The
  worker process owns its own SRT singleton plus `srtReady`/`srtPoisoned`
  state; it never touches the host SRT API or coordinator. Initialization or
  cleanup failure poisons only that worker. The worker reports an infrastructure
  failure, attempts cleanup/reset during bounded shutdown, and exits; recovery
  is a later fresh worker, not a host-coordinator reset.
- `SandboxPolicy` keeps independent `allowWrite`, `denyRead`, `denyWrite`, and
  network rules; deny rules are never unioned. Linux activation rejects any glob
  in `denyRead`/`denyWrite` because SRT cannot enforce it. SRT-owned bash keeps
  the 120s host deadline and file operations keep 30s, with the existing output
  bounds and detached-process-group cleanup. The native Pi executor used by an
  approved command escalation has its own 120s default, output-tail/temp-file
  behavior (2000 lines / 50 KiB), and abort cleanup; those are not SRT hard byte
  limits. Guardian uses full-read/zero-write/zero-net SRT policy, a minimal
  replacement environment, and an explicit trusted host home for `~` path
  resolution; `rg` runs only from a parent-resolved absolute executable.
- Git metadata is modeled by `git-metadata.ts`: ordinary and linked metadata
  roots are readable but not writable under the base SRT policy; their
  `<gitdir>/hooks` descendants are hard-denied there. Git status/stash/log/revparse
  and other read-only or compound inspections remain ordinary LOW/SRT operations.
  Git mutations, including `init`, remain ordinary sandbox executions unless the
  exact Bash call explicitly requests `sandbox_permissions=require_escalated`;
  then the Engine routes that one frozen command/cwd through Guardian action
  review and a one-shot bare Pi executor. Default Git/.agents/.codex carveouts
  are not permanent hard denies on that reviewed escalated executor; explicit
  configured denies and active delegation ceilings still make escalation
  ineligible. No Git-specific write grant or unsandboxed fallback is created.
  Guardian's `rg` path is realpath-resolved by the parent and the child executes
  that absolute identity. The shared sandbox Bash/file execution entrypoint
  re-discovers metadata roots from the actual `cwd` for each execution and only
  appends deny rules to that invocation's policy; discovery failures fail
  closed before execution. This does not modify the Engine snapshot or lease
  and does not cross the independent Guardian worker boundary.
- Generic tools use `host-admission`: the Engine can review their exact
  external-tool capability, but SRT only enforces sandbox-owned
  bash/write/edit and permission-amendment executions. Temporary scratch
  follows the SRT backend defaults and is not treated as a workspace grant.
- Permission rule evaluation lives under `src/permissions/`.
- Design history: `docs/superpowers/{plans,specs}` and dated notes in
  `docs/research/`; task briefs and review diffs in `.superpowers/sdd/`.

Development dependencies pin the validation target: `@earendil-works/pi-coding-agent` 0.85.1 —
check its API surface before upgrading assumptions about extension hooks. Use pnpm
for dependency installation and recheck the pinned Pi package versions on the next
Pi upgrade.
