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
  exact one-shot grants, exact grantable-deny leases, denial circuit breaking,
  `/approve` retry handles, and turn/session-scoped permission amendments.
- `src/pi-approve-for-me-adapters.ts` translates the host's static risk result
  into an `AdmissionPlan` and adapts the Guardian implementation. The Engine
  owns authorization; adapters own only host integration and enforcement.
- `src/permission-session.ts` is the host lifecycle/barrier state machine. It
  tracks generations, turn lifecycle, execution snapshots, and mode mutation
  barriers; it does not own approval or capability state.
- Sandbox enforcement is backed by the pinned `@anthropic-ai/sandbox-runtime`
  `0.0.74` adapter (`src/sandbox/srt-enforcer.ts`). The public seam is the
  backend-neutral `SandboxManagerLike.execute({ policy, program, cwd, env })`;
  only the adapter serializes argv for SRT's `wrapWithSandboxArgv()` and
  spawns with `shell: false`. `src/sandbox/srt-coordinator.ts` owns one
  exclusive lease per Pi host process. It serializes SRT mutation across every
  registration and ordinary sandboxed tool; the production Guardian does not
  enter this coordinator. Host SRT state lives in `processSandboxState` in
  `src/sandbox/srt-enforcer.ts`, while the host poison latch lives on
  `srtProcessCoordinator`. At a deadline the caller returns immediately and
  the host executor is poisoned, but the detached drain keeps the lease until
  every mutable SRT operation settles and child/cleanup completes. Cleanup or
  policy-restore failure also poisons the host and later executions fail closed.
  Only a successful `SrtSandboxManager.activate()` clears host poison after its
  bounded reset and base-policy initialization. `reset()` (including
  `yolo`/disabled transitions) tears down host SRT/base/connect state but does
  not itself clear the poison latch.
- Production Guardian evidence tools run through
  `createIsolatedGuardianToolRuntime()` and `src/guardian-worker.mjs`. The
  worker process owns its own SRT singleton plus `srtReady`/`srtPoisoned`
  state; it never touches the host SRT API or coordinator. Initialization or
  cleanup failure poisons only that worker. The worker reports an infrastructure
  failure, attempts cleanup/reset during bounded shutdown, and exits; recovery
  is a later fresh worker, not a host-coordinator reset.
- `SandboxPolicy` keeps independent `allowWrite`, `denyRead`, `denyWrite`, and
  network rules; deny rules are never unioned. Linux activation rejects any glob
  in `denyRead`/`denyWrite` because SRT cannot enforce it. The host deadline is
  120s for bash and 30s for each file operation, with output bounds and
  detached-process-group cleanup. Guardian uses full-read/zero-write/zero-net
  SRT policy, a minimal replacement environment, and an explicit trusted host
  home for `~` path resolution; `rg` runs only from a parent-resolved absolute
  executable.
- Git metadata is modeled by `git-metadata.ts`: ordinary and linked metadata
  roots are readable but not writable, with `<gitdir>/hooks` always hard-denied.
  Only a typed, canonical system-Git `init` plan may enable `allowGitConfig`;
  its adapter pre-creates a verified `.git` directory, releases only exact
  config deny identities, and uses an empty controlled template directory plus
  per-run replacement `HOME`/`XDG_CONFIG_HOME` and `GIT_CONFIG_GLOBAL=/dev/null`.
  Failure never falls back to an unsandboxed command; newly created metadata is
  removed only when it is still empty, while partial metadata is retained and
  reported. Guardian's `rg` path is realpath-resolved by the parent and the
  child executes that absolute identity.
- Generic tools use `host-admission`: the Engine can review their exact
  external-tool capability, but SRT only enforces sandbox-owned
  bash/write/edit and permission-amendment executions. Temporary scratch
  follows the SRT backend defaults and is not treated as a workspace grant.
- Permission rule evaluation lives under `src/permissions/`.
- Design history: `docs/superpowers/{plans,specs}` and dated notes in
  `docs/research/`; task briefs and review diffs in `.superpowers/sdd/`.

Peer deps pin the target host: `@earendil-works/pi-coding-agent` 0.84.4 —
check its API surface before upgrading assumptions about extension hooks.
