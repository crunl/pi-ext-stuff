# pi-safety

Permission modes (`auto` / `yolo`) for the pi coding agent, with sandboxed
tool execution and an external Guardian reviewer that approves risky
actions on your behalf. The extension is distributed as `.ts` sources —
pi loads extensions directly through jiti, so there is **no build step**.

Everything below is derived from the source. Paths are relative to
`extensions/pi-safety/` unless stated otherwise. This file replaces the
module's previous documentation set, which was deliberately removed; the
rewrite is not based on it.

## Contents

1. [What the extension does](#what-the-extension-does)
2. [Static risk analysis: how a bash command is decided](#static-risk-analysis-how-a-bash-command-is-decided)
3. [The policy layer (`risk-policy.ts`)](#the-policy-layer-risk-policyts)
4. [Runtime enforcement and sandbox](#runtime-enforcement-and-sandbox)
5. [Network boundary, host, and domain patterns](#network-boundary-host-and-domain-patterns)
6. [The Guardian reviewer](#the-guardian-reviewer)
7. [Approve-for-me engine and adapters](#approve-for-me-engine-and-adapters)
8. [Delegation and session lifecycle](#delegation-and-session-lifecycle)
9. [Configuration schema](#configuration-schema)
10. [Testing](#testing)
11. [Known boundaries and limits](#known-boundaries-and-limits)

## What the extension does

The extension registers four owned tools (`bash`, `write`, `edit`,
`request_permissions`), two commands (`/approve` and `/permissions` — the
latter is read-only in its `status` form and a config reload otherwise),
and a `tool_call` gate for the host-first read tools (`read`, `grep`,
`find`, `ls`) and `subagent` (`src/register.ts:237`,
`src/register.ts:243`, `src/register.ts:547`, `src/register.ts:2616-2636`,
`src/register.ts:2644`, `src/register.ts:2780`).

Two permission modes exist (`src/state.ts:5`, `src/modes/controller.ts:3`):

- **auto** — the Guardian reviewer approves risky actions on the user's
  behalf. This is the default mode (`src/state.ts:39-46`).
- **yolo** — unrestricted execution. It bypasses the static risk layer
  (`executePermissionedBash` routes to `executeYoloDirectBash`,
  `src/register.ts:1747-1756`; `riskForFileMutation` returns early at
  `src/register.ts:1938`) and skips both the host-first deny preflight and
  the `subagent` spawn gate (`src/register.ts:1554`, before the gate at
  `:1557`).

The retired human-popup `default`/`plan` modes are gone; `ModeController`
cycles `auto` → `yolo` → `auto` and nothing else
(`src/modes/controller.ts:3-26`).

`auto` still means only "the guardian reviews on your behalf" — it does
not widen or narrow the sandbox. `yolo` is the only unrestricted path in
the extension.

## Static risk analysis: how a bash command is decided

The static layer classifies an owned tool call **before** any model is
consulted. Its output vocabulary is the disposition
`"Skip" | "NeedsApproval" | "Forbidden"`
(`src/permissions/risk.ts:81`), named after Codex's
`ExecApprovalRequirement` (`Skip { bypass_sandbox }`,
`NeedsApproval { reason }`, `Forbidden { reason }`).

Four proof tiers, three dispositions (`src/permissions/risk.ts:1-21`):

| Tier | Meaning | Disposition |
| --- | --- | --- |
| 1 | proven dangerous (forced `rm`, `sudo` pass-through, `env` wrapper) | `NeedsApproval` |
| 2 | proven side-effecting (process control, unclassified remote effect) | `NeedsApproval` |
| 3 | proven safe (static argv = runtime argv) | `Skip` |
| 4 | unclassifiable | `NeedsApproval` |

Tiers 2 and 4 are both reviews from opposite directions: tier 2's argv
is fully determined but its effect is not confined by filesystem/network
policy; tier 4's argv is not determined at all. Tier 3 is the only
auto-approve, so tier 4 fails closed into review rather than downgrading
into it (`src/permissions/risk.ts:1-21`). A proven-dangerous command is
a review the user settles, not a hard block — Codex's
`AskForApproval::OnRequest` → `Prompt` arm; Codex's `Never → Forbidden`
arm is unreachable because `yolo` bypasses this layer entirely
(`src/permissions/risk.ts:291-302`).

### The analysis chain

The entry point is `classifyRiskWithCause` (`src/permissions/risk.ts:270`),
which composes:

1. **`shell-lexer.ts`** — segment splitting, quoting/escape handling,
   redirect recognition, lexical-defect detection. `splitShellSegments`
   (`src/permissions/shell-lexer.ts:174`) splits a command line on the
   shell's own statement boundaries (`;`, `&`, `|`, `\n`, grouping
   parentheses) and nothing inside a heredoc body; a heredoc body is
   input data, not code. `shellWords` (`src/permissions/shell-lexer.ts:232`)
   produces the word list and reports `ShellLexError`
   (`"unbalanced-quote" | "trailing-escape" | "nul-byte"`,
   `src/permissions/shell-lexer.ts:214`). `scanShellSyntax`
   (`src/permissions/shell-lexer.ts:604`) returns raw-text facts
   (executable substitution, active redirect, heredoc, live
   substitutions).
2. **`shell-ast.ts`** — the tree-sitter-bash front end (V2). Opt-in:
   the host installs it only when `PI_SAFETY_TREE_SITTER_PARSER=1`
   (`src/tree-sitter/shell-backend.ts:244-249`). V2 may only make a
   verdict **stricter**; any command the two front ends read differently
   falls back to the whole lexer (`astSegmentFacts` returns `undefined`,
   `src/permissions/shell-segment.ts:925`). `installShellAstParser`
   (`src/permissions/shell-ast.ts:156`) injects the parser so the
   permission layer stays pure; the bridge in `src/tree-sitter/`
   is the only place that reads the `.wasm` off disk
   (`src/tree-sitter/shell-backend.ts:1-40`).
3. **`shell-segment.ts`** — wrapper reduction and `CommandSegment`
   construction. `parseCommandSegments`
   (`src/permissions/shell-segment.ts:880`) reduces `env`/`sudo`/`VAR=…`
   wrappers, expands `shell -c` bodies into their own segments, and
   records per-segment facts. `foldSegment`
   (`src/permissions/shell-segment.ts:800`) names the first failed
   clause of the `decomposable` conjunction as `unprovenCause`
   (`lex_incomplete`, `wrapper_unreduced`, `nested_git_program`,
   `command_word_unproven`, `program_reinterpreted`,
   `substitution_unproven`, `heredoc_unproven` —
   `src/permissions/rules.ts:31`).
4. **`rules.ts`** — the `CommandSegment` record
   (`src/permissions/rules.ts:40`), the `PermissionRule` shape
   (`action`/`tool`/`pattern`, `src/permissions/rules.ts:8-14`),
   and `matchRules` (`src/permissions/rules.ts:113`), which resolves
   user rules with `deny` > `ask` > `allow` precedence
   (`src/permissions/rules.ts:99-129`).
5. **`risk.ts`** — the tier composition above.
6. **`command-effects.ts`** — effects that outlive the invocation and
   the sandbox cannot contain: `kill`/`pkill`/`killall`
   (`src/permissions/command-effects.ts:32`,
   `invocationControlsProcesses` at `:42`) and bare package-manager
   invocations (`npm`/`pnpm`/`yarn`/`bun` with no subcommand,
   `src/permissions/command-effects.ts:113`,
   `invocationRemoteEffectUnclassified` at `:138`).
7. **`dangerous-commands.ts`** — `rm` with `-f`/`--force` (or a flag
   bundle containing `f`), recursed through `sudo`/`env` wrappers and
   `trap` actions, bounded at wrapper depth 8
   (`src/permissions/dangerous-commands.ts:9`, `:47`). This mirrors
   Codex's `is_dangerous_command.rs` in three of four arms; `trap` and
   the `bash -lc` literal recursion are handled by
   `shell-segment.ts`/`risk.ts` instead (`src/permissions/dangerous-commands.ts:1-5`).
8. **`residual.ts`** — the closed residual-signal vocabulary
   (`src/permissions/residual.ts:4-32`) that co-stamps a review with
   *which proof failed*. A residual is observational and never a skip
   credential (`src/permissions/residual.ts:126-134`).
9. **`paths.ts`** — canonicalizing path decisions for write roots,
   denyRead/denyWrite, and protected paths (`isPathAllowed`,
   `src/permissions/paths.ts:79`).
10. **`cd-normalize.ts`** — folds a leading literal `cd <dir>` when
    every following segment is provably cwd-independent
    (`normalizeKnownCwdDirectory`, `src/permissions/cd-normalize.ts:97`).
    The fold is subtraction only: the returned list is always a subset
    of the input (`src/permissions/cd-normalize.ts:1-31`).
11. **`git-network.ts`** — git remote parsing and the git invocations
    that use the network (`gitNetworkSubcommands` =
    `clone|fetch|pull|push|ls-remote`, `src/permissions/git-network.ts:10`;
    `analyzeShellGitNetwork` at `:537`).
12. **`git-exec-entries.ts`** — git config/env keys that make git run
    another program. `gitScalarConfigSegments` is an **allowlist** of
    config-key tails that cannot denote a program, so an unlisted key is
    unproven rather than allowed (`src/permissions/git-exec-entries.ts:45`).
    `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_CONFIG_NOSYSTEM`
    redirect where git reads config
    (`gitConfigSourceEnvNames`, `src/permissions/git-exec-entries.ts:103`).
13. **`shell-network.ts`** — `invocationUsesNetwork`
    (`src/permissions/shell-network.ts:82`) and
    `extractShellNetworkHosts` (`:129`), which map a command to the
    hosts it would contact. Authorization itself happens at the runtime
    connection boundary, not here (`src/permissions/shell-network.ts:1-4`).

### Review causes

`ReviewCause` (`src/permissions/risk.ts:97-104`) names the mechanism
that failed, never the disposition it produced — the `risk_not_low`
rename is why: a tag naming a disposition lies the next time the
disposition vocabulary moves. `unproven_other` is the defensive member:
reaching it means a new refusal path forgot to name itself
(`src/permissions/risk.ts:84-96`). The cause co-stamps the review as a
residual signal (`causeToResidual`, `src/permissions/residual.ts:96`)
and never changes a disposition.

## The policy layer (`risk-policy.ts`)

`evaluateRiskRequest` (`src/risk-policy.ts:230`) is the composition
root: it turns a host tool call into a `RiskDecision`
(`src/risk-policy.ts:21-39`) of `allow` / `prompt` / `block`.

Parity design rationales recorded in the source:

- **Disposition vocabulary** — the three levels are Codex's, from
  `ExecApprovalRequirement` in `codex-rs/core/src/tools/sandboxing.rs`
  at the pinned `129fd21`. `isDangerousWords` mirrors Codex's
  `dangerous_command_match_for_exec` (`is_dangerous_command.rs:123-150`)
  in three of its four arms — `rm` with a force option, `sudo`
  pass-through, and the `env` assignment skip — and in the wrapper
  depth bound of 8. Codex's `trap` arm lands in `isDangerousSegment`;
  its `bash -lc` literal recursion is done by `parseCommandSegments`;
  its basename lookup happens in `shell-segment.ts` before a segment is
  built. One deliberate divergence: Codex does not fold case on POSIX,
  this package does. Codex's Windows/PowerShell rules have no
  counterpart (`src/permissions/risk.ts:44-70`).
- **fx is not the reference for this shape** — its
  `Risk { low, medium, high, critical }` paired with
  `Decision { clear, caution }` is a two-axis assessment produced by a
  model reviewer; a static classifier has no producer for a four-point
  score (`src/permissions/risk.ts:71-74`).
- **Escalation parity** (`sandboxing.rs` `unsandboxed_execution_allowed`):
  denied *reads* only exist inside the sandbox. A command escalation
  (`sandbox_permissions=require_escalated`) stays runnable under the
  ordinary sandboxed path when `denyRead` is empty; `denyWrite` /
  `deniedDomains` alone do not suppress escalation
  (`src/risk-policy.ts:258-263`, `src/escalation-policy.ts:38-40`).
- **Implicit git remote binding** — an escalated action runs on the bare
  local backend outside the per-connection authorizer, so a destination
  that came from repository metadata is in no place that could bind it.
  `escalationRequested && usesImplicitGitNetwork` is refused outright
  rather than approved as if bound (`src/risk-policy.ts:258-296`).
- **Unproven git grammar** — `git -c KEY=VALUE` can install a hook
  directory or an alias that the same invocation then runs, so an
  unproven git context is a review (not a refusal), matching the
  `env -C DIR` precedent. It can only *raise* a `Skip`, never lower a
  verdict the classifier already set (`src/risk-policy.ts:305-330`,
  `:465`).
- **No per-CLI verb grammar** — a search for `kubectl`, `gh`, `aws`,
  `gcloud`, `vercel`, `netlify`, `terraform` in the pinned Codex
  shell-command crate returns zero files. A verb denylist cannot supply
  what `invocationRemoteEffectUnclassified` is for: it can show that
  `delete` is dangerous but cannot show that `pr edit` is, and the
  omission is invisible. The enforced boundary is the network lease
  (`src/permissions/command-effects.ts:64-111`).

The remaining decision flow (`src/risk-policy.ts:377-519`):

- `request_permissions` is a special shape-gated path
  (`isSupportedPermissionRequestShape`, `src/risk-policy.ts:44`): it
  accepts turn-scoped `network.hosts`, `network_access: true`, and/or
  `file_system.write` lists, and produces a `prompt` that becomes an
  Engine permission amendment.
- Escalation (`require_escalated`) is supported only for `bash` with a
  `command` and a non-empty `justification`
  (`src/risk-policy.ts:246-256`, `src/shell-permissions.ts:112`).
- User `rules` are matched first; a `deny` blocks before anything else
  (`src/risk-policy.ts:349-351`).
- `classifyRiskWithCause` runs with the resolved filesystem policy
  (`src/risk-policy.ts:377-418`).
- Deletion-command targets are checked against the sandbox write roots
  *before* execution, so hard protected-path carve-outs are caught
  statically; ordinary outside-root writes are discovered by the real
  sandbox and reviewed with its exact denial
  (`src/risk-policy.ts:405-452`).
- Write-path resolution produces `NeedsApproval` for outside-root writes
  and `Forbidden` for protected-pattern matches
  (`src/risk-policy.ts:433-496`).

Host-first B (`read`/`grep`/`find`/`ls`) does **not** enter this chain:
`evaluateHostFirstRulesOnly` (`src/risk-policy.ts:194`) honours only a
configured `rules[]` deny. `ask`/`allow`/no-match on that channel are
ignored — no Engine authorization, no Guardian, no sandbox ownership
(`src/risk-policy.ts:191-193`, `src/register.ts:2619-2636`).

## Runtime enforcement and sandbox

The sandbox is backed by **pristine** `@anthropic-ai/sandbox-runtime@0.0.77`
(no pnpm patch, no `network.mode`). The public seam is the
backend-neutral `SandboxManagerLike.execute({ policy, program, cwd, env })`
(`src/sandbox-policy.ts:274-306`); only the adapter serializes argv for
SRT's `wrapWithSandboxArgv()` and spawns with `shell: false`
(`src/sandbox/srt-enforcer.ts:235-255`, `:275-330`, `shell: false`
at `:293`).

### Module split

- **`sandbox-policy.ts`** — the pure policy/projection layer: no
  fs/git I/O. Owns `SandboxPolicy` (`src/sandbox-policy.ts:29`),
  `projectExecutionNetwork` (`:61`), `createSandboxRuntimeConfig`
  (`:345`), `createGuardianReadOnlySandboxConfig` (`:300`), and the
  `SandboxManagerLike` interface. The Engine imports only this layer.
- **`sandbox.ts`** — process factories: the sandboxed bash wrapper
  (`createSandboxedBashOperations`, `src/sandbox.ts:128`), the sandboxed
  file operations (`createSandboxedFileOperations`, `src/sandbox.ts:739`),
  the Guardian read-only command runner
  (`createSandboxedReadOnlyCommandRunner`, `src/sandbox.ts:250`) and file
  operations. It re-exports the historical seam
  (`src/sandbox.ts:29-70`).
- **`src/sandbox/srt-enforcer.ts`** — the `SrtSandboxManager` adapter
  around SRT's process-global mutable manager
  (`src/sandbox/srt-enforcer.ts:415`).
- **`src/sandbox/connect-guard.ts`** — `SandboxConnectGuard`, the
  loopback parent proxy that authenticates SRT and consumes
  address-bound one-shot tickets.
- **`src/sandbox/srt-coordinator.ts`** — `SrtProcessCoordinator`, one
  exclusive lease per Pi host process; serializes every SRT mutation
  across registrations and ordinary sandboxed tools
  (`src/sandbox/srt-coordinator.ts:32-46`).

### SRT enforcement

`toSrtConfig` (`src/sandbox/srt-enforcer.ts:123`) projects a
`SandboxPolicy` to native SRT config only. Key facts:

- **The callback is the sole authorization seam in production.** SRT's
  own `allowedDomains` is forced empty when the connect guard is active,
  so every unlisted request goes through the same Engine decision and
  the guard binds a DNS answer (`src/sandbox/srt-enforcer.ts:149-158`).
- `$TMPDIR` is injected as a platform default write root (Codex
  `FileSystemSpecialPath::Tmpdir`), gated on a non-empty user write set
  so read-only profiles and resolved-empty delegation intersections stay
  zero-write (`src/sandbox/srt-enforcer.ts:130-140`).
- Unix sockets are a separate OS axis from the Engine TCP lease:
  `allowUnixSockets` / `dangerouslyAllowAllUnixSockets` project only to
  native SRT fields; empty/absent omits them so SRT keeps AF_UNIX
  blocked (`src/sandbox/srt-enforcer.ts:138-157`).
- When the connect guard has a live `parentProxyUrl`, SRT is given
  `enableWeakerNetworkIsolation: true` so Go TLS tools (`gh`, gcloud)
  can evaluate certificates via trustd inside the seatbelt. This is a
  **deliberate security downgrade** from SRT's native default `false`
  (Anthropic SRT warning: trustd helper-mediated egress); functionality
  proves connectivity, not isolation equivalence. Unstarted guards do
  not inject (`src/sandbox/srt-enforcer.ts:160-169`,
  `:175-177`, `:111-113`).
- Default output bounds are 16 MiB stdout / 1 MiB stderr
  (`src/sandbox/srt-enforcer.ts:30-31`); the host deadline is 120 s for
  bash and 30 s for file operations
  (`src/sandbox.ts:65`, `src/sandbox.ts:68`).

`askNetwork` (`src/sandbox/srt-enforcer.ts:179`) is the per-connection
authorizer: it asks the Engine's `networkAuthorize` callback, checks the
approved endpoint against the exact host/port, verifies the callback
identity has not been replaced mid-flight, then asks the connect guard to
consume a ticket. SRT's parent-proxy seam unconditionally bypasses its
parent for loopback destinations, so an approved loopback endpoint is
validated but no guard ticket can be consumed on that path
(`src/sandbox/srt-enforcer.ts:179-233`).

The SRT lifecycle (`activate`, `reset`, `execute`, `describeState`,
`waitForIdle`, `readFailureDiagnostics`) is serialized through
`srtProcessCoordinator.runExclusiveDetached`. Execution cancellation
returns to the caller immediately, but the detached drain keeps the lease
until every mutable SRT operation settles; a drain deadline never
releases an unsettled lease. Cleanup, policy-restore, or drain failure
**poisons** the host with its actual lifecycle cause, and later
executions fail closed. Only a successful `SrtSandboxManager.activate()`
clears host poison after its bounded reset and base-policy
initialization; `reset()` tears down host SRT/base/connect state but does
not itself clear the poison latch (`src/sandbox/srt-coordinator.ts:32`,
`src/sandbox/srt-enforcer.ts:415-778`).

SRT violation logs are bounded, labelled diagnostics only — available
spaces preserved, control characters escaped, sanitized/unrelated
observations never select an authorization scope
(`readFailureDiagnostics`, `src/sandbox/srt-enforcer.ts:689-716`).

### Escalated bash and native recovery

A `require_escalated` bash call that passes hard policy runs once on the
bare local backend outside the sandbox (`isExactEscalatedBashCall`,
`src/approve-for-me-engine.ts:886`; `CapabilityLease` mode
`"escalated"`).
Native Write/Edit recovery uses attempt-local parent-side operation
evidence from `createSandboxedFileOperations`, not a parsed denied path;
only access failures before content-write entry can trigger fresh Engine
review of the frozen complete action. A second failure is terminal
(`RuntimeDenialPolicy`, `src/approve-for-me-engine.ts:41`).

`bash-outcome.ts` owns the completed-command seam: `captureExitCode`
captures the child's exit code at the operations wrapper, and
`completedIfCommandRan` decides whether a thrown status is the command's
own result rather than a permission failure, carrying the status as
`details.exitCode`. The registered `tool_result` handler is the only
channel that can mark such a result as an error, because pi returns
every *returned* tool result with `isError: false`
(`src/bash-outcome.ts:1-30`, `src/register.ts:2638-2643`).

## Network boundary, host, and domain patterns

Three modules, three concerns:

- **`network-boundary.ts`** — the parent-side DNS boundary
  (`NetworkBoundary`, `src/network-boundary.ts:136`). It resolves a host
  once (2 s budget, `DEFAULT_NETWORK_RESOLUTION_TIMEOUT_MS` at `:13`),
  freezes the answers into an endpoint, and hands the endpoint to the
  connect guard. The guard must dial only these frozen literals, which
  closes the rebinding window between approval and the socket connection
  (`src/network-boundary.ts:131-135`). A hostname with any
  private/special answer is rejected even if another answer is public,
  unless the explicit local-binding mode is on; trusted TUN ranges
  (`trustedFakeIpRanges`) are the narrow exception
  (`src/network-boundary.ts:269-298`).
- **`network-host.ts`** — host normalization and public/private
  classification (`normalizeNetworkHost`, `isPublicNetworkHost`,
  `isLoopbackAddress`, `parseGitRemoteTarget`). `isPublicNetworkHost`
  rejects `localhost`, `*.localhost`, `metadata.google.internal`,
  ambiguous numeric IP spellings, and every special-use range
  (`src/network-host.ts:136-146`).
- **`network-domain-pattern.ts`** — the small SRT-compatible pattern
  language (`exact` / `*.suffix` / `*`, optional `:port`). Wildcards
  exclude their apex and never match IP literals; invalid patterns are
  rejected so an unsupported spelling can never widen an allow-list
  (`src/network-domain-pattern.ts:31-60`, `:103`).
  `intersectNetworkPatterns` computes the semantic intersection of two
  allow-list unions for delegation; empty input is an empty grant, not
  an implicit wildcard (`:154`).

The **connect guard** (`SandboxConnectGuard`,
`src/sandbox/connect-guard.ts:251`) is a loopback-only HTTP parent
proxy for SRT's internal authenticated proxy: SRT authenticates the
sandbox child; this second hop authenticates SRT and consumes an
address-bound, one-shot ticket minted by the network boundary. Tickets
are capped at 256 with a 30 s TTL (`src/sandbox/connect-guard.ts:18`,
`:19`), and are one-shot: `consume` shifts the endpoint queue
(`src/sandbox/connect-guard.ts:331-352`). The guard also honours the
operator's own `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` upstream
(`src/sandbox/connect-guard.ts:285-287`, `:151-177`).

Effective network authority is derived, never stored:
`effectiveNetworkAuthority` (`src/policy-primitives.ts:93`) computes
`wholeNetwork` from `network_access === true`, with
`allowPrivateTargets`/`allowLocalBinding` defaulting to it. An explicit
`false` on a fine axis wins over `network_access`; `undefined` inherits.
The fine axes may tighten the ledger; `deniedDomains` always vetoes
(`src/policy-primitives.ts:93`).

## The Guardian reviewer

The Guardian is an external LLM judge that re-examines anything the
static policy cannot prove safe. Production evidence tools run through
`createIsolatedGuardianToolRuntime()` (`src/guardian-tools.ts:931`, body
through `:982`) and the worker process, because the in-process SRT manager is a
process-global singleton: an inline network approval can call a Guardian
while the main invocation owns SRT's coordinator and deadlock
(`src/guardian-tools.ts:916-982`).

### What it reviews and when

`PiAutoReviewer.review` (`src/auto-reviewer.ts:278`) runs when the
Engine's admission plan is `review`. Constants
(`src/guardian-policy.ts:1-6`): 90 s review timeout, 3 attempts, 8
tool rounds, 10 recent-denial window. Transient provider failures
(HTTP 500/502/503/504 and the named connection/stream codes,
`RETRYABLE_PROVIDER_STATUSES`/`CODES`, `src/auto-reviewer.ts:70-92`) are
retried via `assertRetryableRequestFailure`
(`src/auto-reviewer.ts:149`) until the attempt budget is spent; anything
else fails immediately. Failures classify as
`unavailable | timeout | cancelled | provider | parse`
(`src/guardian/errors.ts:9-15`).

The reviewer model is `reviewer.model` (a merged `provider/model`
reference split at the **first** slash, because model ids carry slashes
of their own — `src/config.ts:187`), else the active model, else an
active fallback with a notice (`resolveGuardianModel`,
`src/guardian-model.ts:49`). Default reasoning effort is `low`
(`DEFAULT_REVIEW_REASON`, `src/auto-reviewer.ts:69`).

### Policy prompt

`renderGuardianSystemPrompt` (`src/guardian-policy.ts:206`) renders
`CODEX_GUARDIAN_POLICY_TEMPLATE` (`:37`) with a tenant policy
(`CODEX_GUARDIAN_DEFAULT_POLICY`, `:118`) and a strict JSON output
contract (`:184`). The template is adapted from openai/codex at
`88f776588f5e73467e7659c268f8358a9a2378b6`
(`codex-rs/core/src/guardian/{policy_template.md,policy.md,prompt.rs}`),
with two runtime-specific sections adapted to pi (the trusted-content
sources bullet and the `# Execution Environment` section)
(`src/guardian-policy.ts:31-36`).

The floor enforcement that is derivable from the structured assessment
runs locally, not in the model: `critical` risk can never be allowed,
and `high` risk requires `user_authorization` ≥ medium
(`guardianPolicyFloorViolation`, `src/guardian-policy.ts:13-23`).

### Evidence tools

Guardian gets bounded read-only tools — `read`, `grep`, `find`, `ls`,
and `inspect` — through `createSandboxedGuardianToolRuntime`
(`src/guardian-tools.ts:769`). `inspect` runs a command inside the same
OS-enforced read-only sandbox: writes and network are denied. Guardian
cannot write files, access the network, or request nested approvals
(`src/guardian-policy.ts:99-108`). The evidence sandbox is
`createGuardianReadOnlySandboxConfig`: zero writes, zero network
(`deniedDomains: ["*"]`), denyRead inherited from the exact parent
lease (`src/sandbox-policy.ts:300-310`). Guardian uses a minimal
replacement environment and an explicit trusted host home for `~` path
resolution; `rg` runs only from a parent-resolved absolute executable
(`src/sandbox.ts:239`, `src/guardian-tools.ts:323`).

`rg` is bounded: 100 default / 1000 max grep records, 20 max context
lines, 16 KiB argument length, 4 MiB output
(`src/guardian-tools.ts:54-61`). Sensitive patterns (authorization
headers, bearer tokens, basic auth) are redacted in tool results
(`src/guardian-tools.ts:46-50`).

### Session and transcript

`GuardianReviewSessionManager` (`src/guardian-session.ts:176`) keeps one
trunk keyed by `{sessionId, cwd, configFingerprint, provider, model,
reasoningEffort, toolFingerprint}`. The trunk's session id is stable per
parent session so provider prompt-cache can prefix-hit across
consecutive reviews (`src/guardian-session.ts:194-199`). It trims to 8
history pairs / 24 000 characters (`src/guardian-session.ts:14-15`),
and chooses **Full** vs **Delta** prompts: Delta is only safe on the
trunk (not forks) and only when the cursor still points inside the
current raw log (`src/guardian-session.ts:207-247`). The raw log is
capped at 500 entries / 200 000 characters; when exceeded the head is
dropped and the epoch bumps so the next review falls back to Full
(`src/guardian-transcript.ts:24-25`).

### Worker process

`guardian-worker.mjs` is deliberately self-contained apart from
`guardian-worker-limits.mjs` — a worker that imports the extension's
TypeScript would not be a reliable process entry point for an installed
package (`src/guardian-worker.mjs:10-12`). The worker owns its own SRT
singleton plus `srtReady`/`srtPoisoned` state; it never touches the
host SRT API or coordinator. Initialization or cleanup failure poisons
only that worker; the worker reports an infrastructure failure, attempts
cleanup/reset during bounded shutdown, and exits. Recovery is a later
fresh worker, not a host-coordinator reset (`AGENTS.md`, "Layout
notes"). The wire protocol is a length-framed JSON-RPC-ish channel
capped at 8 MiB frames / 256 KiB requests / 64 KiB stderr
(`src/guardian-worker-limits.mjs:3-5`).

`guardian-diagnostic.ts` powers `npm run diagnose:guardian`: a
read-only real worker/SRT diagnostic with a deterministic local reviewer
stub (no provider or network request), emitting phase plus fixed
call/review correlation metadata as JSONL schema v2, and exiting
non-zero on Guardian initialization, timeout, poison, or cleanup errors.
`failure.stage` and `failure.code` come from structured worker/reviewer
errors, never from message text
(`src/guardian-diagnostic.ts:32-54`, `:221-249`).

`guardian-metrics` records terminal status, failure reason, session
kind (`trunk_new | trunk_reused | ephemeral_forked`), action tag,
request source, and ownership (`src/guardian/metrics.ts:5-35`).

## Approve-for-me engine and adapters

`src/approve-for-me-engine.ts` is the deep, I/O-free decision module. It
owns admission-plan validation, hard policy checks, Guardian review
routing, exact one-shot grants, exact command-escalation leases, denial
circuit breaking, `/approve` retry handles, and turn/session-scoped
permission amendments (`createApproveForMeEngine`,
`src/approve-for-me-engine.ts:1024`).

Key mechanics:

- **Admission plans** (`src/approve-for-me-engine.ts:51-87`):
  `allow` / `review { capability | action }` / `deny`. A review with
  requested capabilities is a capability review; with none it is an
  action review.
- **`requestCovered`** (`src/approve-for-me-engine.ts:829`) is the
  authorization predicate: a filesystem read is covered unless denied; a
  write must be inside `allowWrite` and outside deny rules; a network
  host must match `allowedDomains` (or `network_access` whole-network
  authority) and not match `deniedDomains`. A network request with a
  port or protocol constraint is **not** sandbox-enforceable
  (`sandboxCanEnforce`, `src/approve-for-me-engine.ts:868`).
- **One-shot grants.** The Engine deletes the armed retry record *before*
  the adapter is entered — the atomic one-shot spend
  (`src/approve-for-me-engine.ts:1472`). `/approve` authorizes one
  exact retry of a recent denial; the handle is single-use
  (`armRetry`, `src/approve-for-me-engine.ts:420`).
- **Denial circuit breaker.** Defaults: 3 consecutive denials, a 50-
  denial window, 10 denials in window (`src/approve-for-me-engine.ts:537-539`).
  When tripped the auto state reports `paused: true` and the UI shows
  the circuit as open; a success resets the counters
  (`src/approve-for-me-engine.ts:1066-1078`).
- **Network authority freezes at attempt creation after review**, not at
  invocation submission: a still-reviewing invocation may see an
  intervening turn grant (`src/register.ts:2230`).
- **`/permissions status`** is read-only inspection; it never activates,
  mutates grants, or poisons a working config
  (`src/register.ts:2786-2840`).

`src/pi-approve-for-me-adapters.ts` translates the host's static risk
result into an `AdmissionPlan` (`admissionPlanFromRiskDecision`,
`src/pi-approve-for-me-adapters.ts:105`) and adapts the Guardian
implementation. The Engine owns authorization; adapters own only host
integration and enforcement. A prompt that becomes `kind:"review"` must
carry non-empty residuals — missing stamps are replaced with
`other_explicit_review`, never mapped to allow/skip
(`src/pi-approve-for-me-adapters.ts:101-104`).

`src/pi-safety.ts` is the host-facing facade: it captures the action
identity at Pi ingress (`captureAction`, `PiCapturedAction`), exposes
`beginTurn`/`beginNestedTurn`/`closeNestedTurn`/`submit`/`closeTurn`/
`invalidate`/`recoverDeniedAction`, and routes nested delegated turns
onto fresh Engines while parking the parent byte-identical
(`src/pi-safety.ts:298-330`).

## Delegation and session lifecycle

Delegated child scopes are effective **intersections** of the parent's
current sandbox policy and the child's requested envelope
(`intersectSandboxPolicy`, `src/delegation.ts:158`). Empty configured
child lists inherit the parent allow set; a resolved empty intersection
grants nothing (`src/delegation.ts:12-19`). Active delegation ceilings
are read from the live nested stack, while the audit trail is
historical only (`src/permission-session.ts:116-134`).

`checkDelegateSpawn` (`src/delegation-policy.ts:63`) refuses a spawn
when any active scope forbids re-delegation or the remaining depth is
exhausted. `checkDelegationWrite`/`checkDelegationNetwork`
(`src/delegation-policy.ts:98`, `:129`) test a write/network request
against the innermost envelope. The whole-network lease is **not**
inherited by delegated child turns: `intersectSandboxPolicy` pins the
child `network_access: false` + `delegated: true`
(`src/delegation.ts:190-191`), so a parent config grant does not open
subagent network.

`src/permission-session.ts` is the host lifecycle/barrier state
machine. It tracks generations, turn lifecycle, execution snapshots, and
mode-mutation barriers; it does not own approval or capability state.
`PermissionSession.maxNestedTurnDepth` is 32
(`src/permission-session.ts:60`); `runModeMutation` serializes mode
mutations so they never interleave, and an operation superseded by a
later generation bump resolves to `undefined` without running
(`src/permission-session.ts:307-326`).

`src/permission-copy.ts` renders the user-facing copy
("Approve for me" / "Bypass permissions", review notices, exact-retry
instructions); `src/review-renderer.ts` and `src/review-presenter.ts`
project review events into the TUI. The mode label is also published two
other ways: as the `pi-safety` UI status (`ctx.ui.setStatus`,
`src/register.ts:416-417`) and as the structured `pi-safety:mode`
(`:421`), `pi-safety:review` (`:303`), and `pi-safety:delegation` (`:714`)
event-bus messages. `pi-core`'s editor chrome subscribes to
`pi-safety:mode` for the mode badge; `statusline` reads the `pi-safety`
UI status key. Consumers should key off the event's `mode`/`severity`
fields, never the human-readable label (`src/register.ts:418-428`).

## Configuration schema

Runtime config is resolved from `agentDir` (official `getAgentDir()`:
`PI_CODING_AGENT_DIR` or `~/.pi/agent`), decoupled from install layout
so `pi install npm:...` works (`src/policy-primitives.ts:33-41`):

1. `{agentDir}/safety.json` — canonical source
2. `DEFAULT_CONFIG` — when the file does not exist

The config path is a protected write target; the fingerprint binds
content only, not path (`fingerprintConfig`, `src/config.ts:641`).
`config.example.json` in the package root is the schema example.

**Unknown keys are a hard error, not silently ignored.**
`rejectUnknownKeys` throws `ConfigError` for any key outside the
accepted list (`src/config.ts:301-308`), applied at every level:
top level (`src/config.ts:319`), `reviewer` (`:340`), `sandbox`
(`:356`), `sandbox.network` (`:410`), each `rules[]` entry (`:494`),
and `delegation` (`:510`). A typo in `safety.json` makes the whole
extension refuse to load, by design.

The full accepted schema (`src/config.ts:15-79`, `:319-521`):

- `version` — must be `1`.
- `reviewer` — `{ model: "provider/model", reasoningEffort: "minimal" | "low" | "medium" | "high" }`.
  `reviewer.timeoutMs`, `reviewer.maxAttempts`, and
  `reviewer.maxConsecutiveDenials` are rejected as "fixed by the
  Auto-review policy" (`src/config.ts:329-339`).
- `sandbox.enabled` — boolean.
- `sandbox.profile` — `"workspace-write" | "read-only"`.
- `sandbox.filesystem` — `allowWrite`, `denyRead`, `denyWrite` (arrays
  of strings).
- `sandbox.network`:
  - `access` — deprecated; ledger/status only. `"inline-proxy"` or
    `{ kind: "explicit", transport: "proxy" | "direct" }`.
  - `network_access` — boolean. The Engine lease axis: when `true`,
    `requestCovered`/`effectiveNetworkAuthority` treat whole-TCP as
    authorized for owned spawn/connection decisions. It is **not** an
    OS direct whole-open. Orthogonal to auto/yolo.
  - `allowPrivateTargets` — boolean (fine axis; explicit `false` wins
    over `network_access`).
  - `macosTls` — `"strict" | "system"` (deprecated for wrap-level
    network modes; `system` requires macOS and conflicts with
    destination denies, delegated confinement, or native local
    exceptions — `src/policy-primitives.ts:107-134`).
  - `allowedDomains` — SRT domain patterns (no `*` allowed).
  - `deniedDomains` — SRT domain patterns (`*` allowed; always vetoes).
  - `trustedFakeIpRanges` — CIDR ranges reserved for a user-managed
    TUN/fake-IP resolver.
  - `allowLocalBinding` — boolean; high privilege (local bind/inbound
    and loopback outbound).
  - `allowUnixSockets` — absolute exact socket-file paths (no globs,
    no directories; macOS SRT matches allowlist entries as seatbelt
    subpaths, so a directory would silently grant every socket beneath
    it — `src/config.ts:208-229`).
  - `dangerouslyAllowAllUnixSockets` — boolean; high privilege.
- `rules` — array of `{ action: "allow" | "ask" | "deny", tool: string,
  pattern?: string }`. `tool` matches by exact name or glob
  (`src/permissions/rules.ts:113-129`).
- `delegation` — `{ enabled: boolean, maxDepth: 0-31, allowReDelegate:
  boolean, writeRoots: string[], networkHosts: string[] }`.

Two removed fields are explicit errors: `sandbox.network.enabled`
(`src/config.ts:404-409`, "use `sandbox.network.network_access`") and
any of the three fixed reviewer policy keys.

`validateNetworkPolicy` (`src/policy-primitives.ts:86-134`) cross-checks
the whole network object at load: `direct` transport requires
unrestricted private/special eligibility and no domain constraints or
delegation; `allowLocalBinding` is incompatible with grant-dependent
explicit access; `macosTls: "system"` requires macOS and conflicts with
destination denies, delegation, or local exceptions.

## Testing

54 test files (53 `.test.ts` plus the `git-fixtures.ts` helper), about
27 162 lines (27 151 in the 53 `*.test.ts` files), under `tests/`. Run them from the module directory:

```bash
npm test                      # vitest --run (one-shot)
npx vitest --run tests/<name>.test.ts   # single file
npm run check                 # tsc --noEmit
npm run lint                  # biome check .
npm run check:host-turn-boundary  # offline real-host step-boundary check
npm run diagnose:guardian     # read-only real Guardian worker/SRT diagnostic
npm run preflight:sibling     # sibling pi-core present + clean
```

`check:host-turn-boundary` loads this extension through the pinned
`@earendil-works/pi-coding-agent` `createAgentSession` +
`bindExtensions` (print mode), then drives `agent_start` → Shift+Tab →
`turn_start` with a live `ExtensionContext` and a stub SRT manager — no
LLM, no network. It asserts the handler is registered, `session_start`
activates auto, a mid-turn cycle does not touch SRT, the next
`turn_start` applies yolo via reset, and the following boundary restores
auto via activate (`AGENTS.md`).

The suites cover, by area: the static risk chain
(`permissions.test.ts`, `permissions-substitution.test.ts`,
`permissions-residual.test.ts`, `dangerous-commands.test.ts`,
`shell-ast-differential.test.ts` — the V1/V2 differential gate that
keeps "tree-sitter never looser than the lexer" true), the policy layer
(`risk-policy.test.ts`, `config.test.ts`, `config-path.test.ts`), the
Engine (`approve-for-me-engine.test.ts`,
`approve-for-me-engine-native-retry.test.ts`), Guardian
(`guardian-worker.test.ts`, `guardian-tools.test.ts`,
`guardian-session.test.ts`, `auto-reviewer.test.ts`,
`guardian-diagnostic.test.ts`), sandbox enforcement
(`sandbox.test.ts`, `srt-enforcer.test.ts`, `connect-guard.test.ts`,
`network-boundary.test.ts`), delegation
(`delegation.test.ts`, `delegation-policy.test.ts`,
`permission-session-nesting.test.ts`, `pi-safety-nesting.test.ts`), and
the host adapter (`register.test.ts`, the largest at ~181 KB).

`tests/structure-invariants.test.ts` pins the architectural seams: the
"decide-closure purity" assertion (no `node:fs`/`child_process` in
`src/policy-primitives.ts`'s value graph), the
`src/permissions/`-stays-pure split with `src/tree-sitter/` as the only
grammar reader, and the layer boundaries named by the import-graph
review.

There is no CI; green checks are voluntary until a remote gate exists.
Acceptance for a revision is `npm run preflight:sibling`, then
`npm run check`, `npm run lint`, and `npm test` on that tree; changes to
mid-turn mode apply or host lifecycle wiring also run
`npm run check:host-turn-boundary` (`AGENTS.md`).

## Known boundaries and limits

This extension deliberately does **not**:

- **Provide host-first permission governance.** Only owned
  `bash`/`write`/`edit`/`request_permissions` run the full Engine +
  Guardian + SRT chain. Host-first B tools (`read`/`grep`/`find`/`ls`)
  honour only a `rules[]` deny; foreign A (MCP/custom/other extension)
  tools return `undefined` and are host-native, out of governance scope
  (`src/register.ts:2628-2629`). Do not reintroduce host-admission
  Guardian review for foreign/host-first tools without a new product
  decision.
- **Act as a network firewall.** The Guardian reviews; it does not
  authorize network. Uncovered network fails closed at the Engine
  (`permission-required`). Production keeps connect-guard on native
  parentProxy + empty SRT `allowedDomains` + `deniedDomains` + one-shot
  tickets. `network_access:true` is a lease, not an OS direct whole-open.
- **Enforce globs in deny rules on Linux.** SRT cannot enforce them;
  activation rejects any glob in `denyRead`/`denyWrite` on Linux
  (`assertSrtPolicySupported`, `src/sandbox/srt-enforcer.ts:91-107`).
- **Interpret per-CLI verb grammars.** Remote-effect intent is the
  reviewer's judgement; the enforced boundary is the network lease and
  the per-connection authorizer
  (`src/permissions/command-effects.ts:64-111`).
- **Grant Unix sockets through `request_permissions`.** Use
  `sandbox_permissions=require_escalated` or yolo/host shell for daemon
  tools when the allowlist stays empty. Allowing
  `~/.orbstack/run/docker.sock` / `/var/run/docker.sock` ≈ host
  docker-group privilege; Linux path lists are ignored by SRT (seccomp
  all-or-nothing).
- **Model Codex's Windows/PowerShell rules**, or Codex's case-folding
  divergence on POSIX (`src/permissions/risk.ts:65-80`).
- **Migrate permission state across the `pi-permissions` rename.** Mode
  state from the old `pi-permissions-state` name is intentionally not
  migrated — losing it is fail-closed (`README.md`, "Migrating from
  pi-permissions").
- **Claim native enforcement.** `describeState` reports
  `nativeEnforcement: "unknown"` — the public backend does not attest
  kernel installation or TLS success
  (`src/sandbox-policy.ts:262-272`).
- **Treat SRT diagnostics as authorization.** Violation logs are
  bounded, labelled, potentially sanitized observations only
  (`src/sandbox/srt-enforcer.ts:689-716`).

The standing Codex pin for alignment claims is
`129fd21687fbd4ac48133b7abfdcaf52cb6cb01f` (Guardian policy prompt
adaptation at `88f776588f5e73467e7659c268f8358a9a2378b6`). Re-check
when the pinned upstream moves or a cited tree path disappears.

Host-API boundary notes (owned tools vs host-first B vs foreign A;
parallel execute vs attempt freeze; missing host primitives) live in the
"Product boundaries" section of `AGENTS.md` in this module.
