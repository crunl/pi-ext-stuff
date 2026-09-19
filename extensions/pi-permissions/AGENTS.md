# AGENTS.md — pi-permissions

Pi coding-agent extension (`pi.extensions` entry in `package.json`) that adds
permission modes (`auto | yolo` — the human-popup `default`/`plan` modes were
retired; the guardian reviewer now approves on the user's behalf), sandboxed
tool execution, and an external "guardian" reviewer. Loaded directly from
`.ts` by the host's jiti — **no build step**.

## Commands

```bash
npm run preflight:sibling # sibling pi-core present + clean (see Cross-extension dependency)
npm run check     # tsc --noEmit (type check)
npm run check:host-turn-boundary # offline real-host step-boundary check (see below)
npm run lint      # biome check . (pinned @biomejs/biome)
npm run diagnose:guardian # read-only real Guardian worker/SRT diagnostic (bounded JSONL)
npm run test      # vitest --run (one-shot)
npx vitest --run tests/<name>.test.ts   # single test file
```

`check:host-turn-boundary` loads this extension through the pinned
`@earendil-works/pi-coding-agent` `createAgentSession` + `bindExtensions`
(print mode), then drives `agent_start` → Shift+Tab → `turn_start` via the
session's `ExtensionRunner` with a live `ExtensionContext`. Stub SRT manager;
no LLM, no network. Asserts: handler registered; session_start activates auto;
mid-turn cycle does not touch SRT; next `turn_start` applies yolo via reset;
the following boundary restores auto via activate. Run it when changing
mid-turn mode apply or host lifecycle wiring.

`diagnose:guardian` uses a deterministic local reviewer stub (no provider or
network request), emits phase plus fixed call/review correlation metadata, and
exits non-zero on Guardian initialization, timeout, poison, or cleanup errors.
JSONL schema v2 reports `failure.stage` and `failure.code` from structured
worker/reviewer errors, never from message text. An unreported worker exit is
`transport/failed`; only an owned deadline is `timeout`.

Biome is a pinned devDependency (`@biomejs/biome` 2.5.4, matching `biome.json`);
run `npm run lint`. Notable strict rules: `noExplicitAny`, `noConsole`, and
`noNonNullAssertion` are errors; under `tests/**` only `noExplicitAny` and
`noNonNullAssertion` are relaxed (`noConsole` stays an error). Double quotes;
imports must use explicit `.ts` extensions.

## Product boundaries

Approve for me runs entirely in this extension; the Pi host has no first-class
permission mode, grant store, or sandbox. Standing Codex pin for alignment
claims is `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`. Host API limits
(owned tools vs host-first B vs foreign A; parallel execute vs attempt
freeze; missing host primitives) are documented in
`docs/host-api-boundaries.md`. Do not schedule work that contradicts that
boundary note without an explicit product decision. Do not reintroduce
host-admission Guardian review for foreign/host-first tools without a new
product decision.

## Cross-extension dependency

- `src/register.ts` imports from `../../pi-core/standalone.ts` (relative to
  `src/`), i.e. the **sibling extension** `extensions/pi-core`. Typecheck and
  tests fail if that checkout is missing. This repository does **not** pin a
  sibling SHA; green `check`/`test` therefore describe this revision **plus**
  whatever `../pi-core` is on disk.
- Run `npm run preflight:sibling` before recording acceptance. It fails when
  the sibling is absent or its working tree is dirty, prints the sibling short
  SHA, and lists dirty paths. A dirty sibling means results are not
  attributable to this revision alone. To accept a pair without mutating a
  live sibling checkout, run the acceptance commands in a temporary worktree
  pair (`../pi-core` at the sibling SHA, this repo at the revision under
  test); record both SHAs.
- Per `pi-core/AGENTS.md`: import only from its `standalone.ts` — never its
  `index.ts` or `src/**` deep paths (index re-registers the extension).

## Tool execution abort guard

The former binary-patch mechanism (core:install/check/test) was retired on
2026-08-26. Abort-race protection is enforced at the extension layer instead:
wrapped tools reject calls whose signal is already aborted at execute entry.
Upstream tracking of the underlying agent-loop race lives in earendil-works/pi.

## Config

Runtime config is resolved from `agentDir` (official `getAgentDir()`:
`PI_CODING_AGENT_DIR` or `~/.pi/agent`), decoupled from install layout so
`pi install npm:...` works:

1. `{agentDir}/permissions.json` — canonical source
2. `{agentDir}/extensions/pi-permissions/config.json` — legacy fallback (read-only, deprecation notify)
3. `DEFAULT_CONFIG` — when neither exists

Both paths are protected write targets. Fingerprint binds content only, not
path. `config.example.json` in the package root is the schema example.

`sandbox.network.network_access` is a **lease / Engine authority** axis
(Codex `sandbox_workspace_write.network_access` name analogue): when `true`,
`requestCovered` / `effectiveNetworkAuthority` treat whole-TCP as authorized
for **owned** spawn/connection decisions. It is **not** an OS direct
whole-open on pristine SRT. Fine axes (`allowPrivateTargets` /
`allowLocalBinding`) may tighten the ledger: explicit `false` wins over
`network_access`; `undefined` inherits. `deniedDomains` always vetoes.
`sandbox.network.access` and `macosTls:"system"` no longer drive wrap-level
OS network modes (pristine SRT has no `network.mode`). The old
`sandbox.network.enabled` field was removed; loading it throws a migration
error.

This axis is orthogonal to auto/yolo: auto still only means Guardian reviews on
the user's behalf. Production keeps connect-guard on **native parentProxy +
empty SRT allowedDomains** + `deniedDomains` + one-shot tickets. Uncovered
network fail-closed at Engine (`permission-required`); Guardian is not a
network firewall. Whole-network lease is **not** inherited by delegated child
turns (`delegation.ts` pins child `network_access: false` + `delegated: true`);
a parent config grant does not open subagent network. Yolo remains the only
unrestricted path.

## Layout notes

- `src/register.ts` is the Pi host adapter: it loads config, captures turn
  snapshots, maps host tool events to Engine invocations, and owns the concrete
  bash/write/edit/request-permissions adapters.
- `src/register-support.ts` holds pure transcript/mode/timeout helpers extracted
  from the host adapter.
- `src/sandbox-policy.ts` is the pure policy/projection layer (no fs/git I/O);
  `src/sandbox.ts` keeps process factories and re-exports the historical seam.
  Engine imports the pure layer only.
- Production Guardian worker is `src/guardian-worker.mjs` plus the sibling
  `src/guardian-worker-limits.mjs` (shared protocol constants). Any packaging
  or install whitelist must ship both files; a lone worker copy fails bootstrap.
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
- Sandbox enforcement is backed by **pristine** `@anthropic-ai/sandbox-runtime@0.0.77`
  (no pnpm patch). The public seam is the backend-neutral
  `SandboxManagerLike.execute({ policy, program, cwd, env })`; only the adapter
  serializes argv for SRT's `wrapWithSandboxArgv()` and spawns with
  `shell: false`. Network on this path is **native allowlist + parentProxy**:
  production keeps SRT `allowedDomains` forced empty when connect-guard is on,
  plus deniedDomains veto and Engine lease (`requestCovered`) at spawn/connection
  decisions. **Uncovered network fail-closed** (`permission-required`); Guardian
  is not a network firewall. `sandbox.network.network_access` is a **lease**
  (Engine/requestCovered), not an OS direct whole-open. `access` /
  `macosTls:"system"` no longer drive wrap-level OS network modes. When
  connect-guard supplies **parentProxy** (live `parentProxyUrl` after `start`),
  initialize/wrap inject the native SRT field `enableWeakerNetworkIsolation: true`
  so Go TLS tools (`gh`, gcloud, …) can evaluate certificates via trustd inside
  seatbelt. **Product default:** this is a deliberate security downgrade from
  SRT's native default `false` (Anthropic SRT security warning: trustd helper-
  mediated egress). Functionality (e.g. `gh` under Clash TUN) proves connectivity
  only — **not** isolation equivalence. Unstarted guards do not inject. Guardian
  worker stays zero-net without this field. Ticket + empty allowlist +
  `requestCovered` remain the authorization seam; weaker isolation does **not**
  authorize arbitrary network. Not a return of the deleted `network.mode` patch.
  `src/sandbox/srt-coordinator.ts` owns one exclusive lease per Pi host process.
  It serializes SRT mutation across every registration and ordinary sandboxed tool;
  the production Guardian does not enter this coordinator. Host SRT state lives
  in `processSandboxState` in `src/sandbox/srt-enforcer.ts`, while host draining
  and persistent fault state live on `srtProcessCoordinator`. Execution
  cancellation or timeout returns to the caller immediately, but the detached
  drain keeps the lease until every mutable SRT operation settles and
  child/cleanup completes. Successful cancellation cleanup permits the next
  execution without clearing a global fault or reactivating SRT. Draining is
  temporarily unhealthy for bare command escalation; ordinary sandbox requests
  wait behind the lease with cancellation and deadline handling. A drain
  deadline never releases an unsettled lease. Cleanup, policy-restore, or drain
  failure poisons the host with its actual lifecycle cause, and later executions
  fail closed.
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
  are not permanent hard denies on that reviewed escalated executor; configured
  `denyRead` and active delegation ceilings still make escalation ineligible
  (Codex parity: denied reads only exist in-sandbox, so `require_escalated` is
  downgraded to the ordinary sandboxed path rather than HARD-blocked).
  `denyWrite` / `deniedDomains` alone do not suppress escalation. No
  Git-specific write grant or unsandboxed fallback is created.
  Guardian's `rg` path is realpath-resolved by the parent and the child executes
  that absolute identity. The shared sandbox Bash/file execution entrypoint
  re-discovers metadata roots from the actual `cwd` for each execution and only
  appends deny rules to that invocation's policy; discovery failures fail
  closed before execution. This does not modify the Engine snapshot or lease
  and does not cross the independent Guardian worker boundary.
- Tool governance channels (product scope 2026-09-19):
  - **Owned** `bash` / `write` / `edit` / `request_permissions`: Engine +
    Guardian residual + SRT/escalated/amendment — full chain.
  - **Host-first B** `read` / `grep` / `find` / `ls`: `tool_call` only honors
    `permissions.json` `rules[]` **deny** → `{ block: true, reason }`. No
    Engine authorization decision and no Guardian. `rules.ask`/`allow` on this
    channel are ignored; empty `rules` means no extra gate. No sandbox
    ownership. (Host-first may still touch permission **lifecycle**
    activation via `preparePermissionExecution`; that is not an Engine grant.)
  - **Foreign A** MCP/custom/other extension tools: `tool_call` returns
    `undefined` (host-native). Out of governance scope.
  - **`subagent`** remains a residual special: `checkDelegateSpawn` then
    host-first B (not owned execute).
  - **yolo** is unrestricted for this preflight: `tool_call` returns
    `undefined` for host-first **and** `subagent` (skips B deny and the spawn
    gate), consistent with owned yolo skipping static risk. Documented
    product exception — not a silent drop.
  - Temporary scratch for owned SRT still follows SRT backend defaults.
- Permission rule evaluation lives under `src/permissions/`.
- Design history: dated notes in `docs/research/` only. Each note must state
  scope, the standing upstream pin (or an explicit day-of snapshot), and what it
  does not claim. Re-check when the pinned upstream moves or a cited tree path
  disappears; retire a note by deleting it and keeping any still-needed
  assertions in a newer dated note. Host API limits live in
  `docs/host-api-boundaries.md`. Task briefs and review diffs under
  `.superpowers/` are session-local and are not product evidence.
- Acceptance for a revision is: `npm run preflight:sibling` (sibling `pi-core`
  present and clean), then `npm run check`, `npm run lint`, and `npm test`
  pass on that tree. Changes to mid-turn mode apply or host lifecycle wiring
  also run `npm run check:host-turn-boundary` (named slice check). Record
  the commit SHA **and** the sibling short SHA with the result when leaving
  evidence outside the commit body. A dirty-sibling run is provisional/blocked,
  never acceptance — even if check/lint/test are green. Other slice-specific
  checks are named in the change; their result or omission is recorded in the
  commit body or the dated research note for that slice. There is no CI; green
  checks are voluntary until a remote gate exists.

Development dependencies pin the validation target: `@earendil-works/pi-coding-agent` 0.85.1 —
check its API surface before upgrading assumptions about extension hooks. Use pnpm
for dependency installation and recheck the pinned Pi package versions on the next
Pi upgrade.
