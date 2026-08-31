# Codex-equivalent Approve for Me design

**Status:** Implemented and verified against the pinned Codex revision
**Date:** 2026-07-30
**Scope:** `pi-permissions` only

## Goal

Make Pi's `Auto` mode behaviorally equivalent to Codex CLI's **Approve for
me** preset for host-mediated Bash, Write, and Edit execution:

- Authorization happens before effects. Once execution starts, a Bash runtime
  sandbox denial is terminal and the extension never replays the command;
  native Write/Edit may perform one exact, freshly reviewed file retry.
- A Guardian denial, timeout, or review failure terminates the exact execution
  attempt it owns.
- Guardian grants are exact and turn-scoped. The model cannot mint a
  session-scoped grant.
- Guardian is a non-mutating, isolated review session. It receives bounded
  role-tagged parent evidence, can perform bounded read-only local checks, and
  can approve or deny a request; its authority is the parent execution policy
  intersected with read-only access. It cannot write, exceed a parent read
  denial, call MCP/custom tools, or grant itself further permissions.
- Only real user/developer messages, `AGENTS.md`, and host-verified human
  `request_user_input` responses can establish authorization. Ordinary tool
  results, `request_permissions` results, and prior Guardian decisions are
  untrusted context and cannot establish precedent.
- A configured custom Guardian model is preferred, but a missing model or
  unavailable Pi credential falls back to Pi's current active model.
- Guardian policy injection crosses only a trusted extension hook; user
  messages, tool results, project overlays, and `PermissionsConfig` cannot
  replace the system policy.

This is a behavioral alignment, not a copy of Codex's Rust implementation or
its proprietary model catalog. The current target is pinned to Codex commit
[`88f776588f5e73467e7659c268f8358a9a2378b6`](https://github.com/openai/codex/tree/88f776588f5e73467e7659c268f8358a9a2378b6),
so later upstream changes do not silently redefine this contract.

MCP is an explicit product exception chosen by the user: MCP calls keep their
existing default Guardian-bypass behavior. Explicit user-configured `ask` or
`deny` rules remain authoritative and are outside this alignment change. This
exception must not be confused with accidental policy drift in host-mediated
execution paths.

## Codex behavior being matched

The current Codex source selects a Guardian model in this order:

1. The active model's catalog-provided `auto_review_model_override`.
2. The active provider's preferred review model, normally
   `codex-auto-review`, if it is available in the model catalog.
3. The active model itself when no review-model entry is available.

It runs Guardian in a reusable, read-only review session with
`approval_policy = never`; parallel requests use isolated ephemeral forks.
It retries only transient/parse failures, makes at most three attempts within
a 90-second overall deadline, and fails closed rather than switching models
after an attempt has started.

The pinned runtime integration has moved beyond the original Guardian
prompt/policy files. Pi aligns the Guardian prompt, trust boundary,
failure/cancellation behavior, exact turn grant, and no-replay semantics while
preserving Pi's own host interfaces and the default MCP bypass.

Primary references:

- [Guardian selection and retries](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review.rs)
- [Guardian timeout and circuit breaker](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/mod.rs)
- [Provider preferred review model](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/provider.rs)
- [Read-only reusable Guardian session](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review_session.rs)

## Product decisions

### Modes and permission boundary

Pi exposes `auto | yolo`; the retired interactive `default`/`plan` modes are
not part of this design. In `auto`, host-mediated Bash, Write, and Edit use the
workspace sandbox and Guardian at Codex-equivalent approval boundaries. In
`yolo`, the permission evaluator is intentionally bypassed. MCP remains on its
existing default Reviewer-bypass route; explicit configured rules are unchanged.

Neither switching to `auto` nor accepting a Guardian approval may broaden the
sandbox beyond the exact approved capability. A normal Guardian approval is
valid only for the active turn and exact normalized action.

### Guardian model resolution

Pi does not expose Codex's remote `auto_review_model_override` catalog
metadata. The global extension config therefore supplies an optional Pi-model
registry preference:

```json
{
  "reviewer": {
    "provider": "deepseek",
    "model": "registered-model-id",
    "reasoningEffort": "medium"
  }
}
```

Resolution is deterministic:

1. With no `reviewer` config, use the active Pi model.
2. With `reviewer`, resolve `provider` and `model` through Pi's
   `modelRegistry`.
3. If lookup or credential resolution for the configured model fails, emit a
   single non-secret fallback notice and use the active Pi model.
4. If the active model is unavailable too, fail closed and block the action;
   `auto` never falls back to an interactive approval path.

`reviewer` stays **global-only**. A project configuration must not choose a
different approval model, inject credentials, or relax the global policy.
The extension stores no provider key and does not perform login. Pi's
`modelRegistry` remains the sole source for Pi login credentials and custom
provider credentials.

An invalid JSON schema remains a configuration error; only a valid but
unavailable preferred provider/model qualifies for active-model fallback.

### Review execution and failure handling

After a model is selected, the selection is fixed for the whole review:

| Condition | Result |
|---|---|
| transient connection/server/stream failure | retry the same model with backoff |
| malformed Guardian JSON | retry the same model |
| maximum three attempts or 90-second deadline reached | fail closed and block the action |
| provider/parse/timeout failure in `auto` | fail closed and block the action, even when UI is available |
| cancellation or config/session change | invalidate the old review and require fresh approval |
| permission-mode change | keep the in-flight permission turn's snapshot; apply the selected mode and fresh approval context at its next `agent_start` without aborting the outer agent run |
| inline Guardian deny/failure | abort its execution attempt, deny the action, and update the existing circuit breaker |
| Bash runtime filesystem denial | return the denial without Guardian review or command replay |
| native Write/Edit runtime filesystem denial | request one fresh exact Guardian review and retry only that file operation once |
| Guardian allow | grant only the exact normalized call, active turn, and config fingerprint |

Permission-mode transitions have one uniform turn-snapshot rule: every change is
future-effective. An exact in-flight call retains the mode, configuration, and
approval context captured for its permission turn. After `agent_end`, the next
`agent_start` captures the selected mode and receives fresh approval context,
even if a queued continuation begins while Pi still reports working. This does
not reuse a stale approval, broaden a call, or apply to config/session
invalidations; those paths remain fail-closed.

A recent denial record is history, not an authorization capability. Ordinary
`agent_end` cleanup retains those fingerprint-bound records so `/approve` can
select one before triggering the next turn, while clearing any pending override,
exact grant, active review, and human-approval token. Configuration, session,
and branch invalidations clear both denial history and pending capability.

All mediated authorization sites use one effective execution context derived
from that snapshot: Bash, native Write/Edit, risk evaluation, Guardian review,
human confirmation, and exact-call grant matching. The context is usable only
while its turn is active and its captured configuration fingerprint still
matches the loaded global configuration. A changed config, session tree, ended
turn, or late async result therefore blocks or requires a fresh approval; it
cannot inherit a later mode or silently return an authorization result.

There is deliberately no second-model fallback after a request has started.
That avoids hidden policy changes, duplicate long waits, and accidental extra
provider cost. This matches Codex's same-model retry/fail-closed behavior.
Auto reviewer errors never create an exact approval capability and never open
an interactive approval fallback. The user can submit a fresh action after
correcting the reviewer failure, or explicitly select `yolo` outside this
approval flow.

The following are Guardian policy constants, not deployment configuration:

| Constant | Value | Codex-equivalent purpose |
|---|---:|---|
| `GUARDIAN_REVIEW_TIMEOUT_MS` | 90,000 | One aggregate review deadline |
| `GUARDIAN_REVIEW_MAX_ATTEMPTS` | 3 | Same-model retry limit inside that deadline |
| `MAX_CONSECUTIVE_GUARDIAN_DENIALS` | 3 | Pause the Auto turn after repeated denials |
| `MAX_RECENT_GUARDIAN_DENIALS` | 10 in 50 reviews | Secondary denial circuit breaker |

They are deliberately hard-coded. Exposing them in `config.json` would let a
local configuration silently diverge from Codex approval semantics.

### Guardian review-session manager and bounded evidence

Introduce a `GuardianReviewSessionManager` owned by each Pi agent session.

- It owns one reusable **trunk** review context keyed by the active Pi session,
  resolved reviewer model, configuration fingerprint, and working directory.
- The trunk has a stable Guardian system prompt rendered from the selected
  trusted policy or the Codex-equivalent default policy, bounded prior review
  context, no skills, and no memories. Its execution authority is derived from
  the parent policy and intersected with read-only access; parent read denials
  are preserved and write authority is always empty.
- Parent evidence is passed as bounded role-tagged entries (`user`,
  `assistant`, and `tool` with error state). Tool results, including automatic
  `request_permissions` results, remain untrusted evidence rather than policy
  or user authorization. Prior Guardian decisions are context, not precedent.
- The Guardian runtime exposes only read-only local tools (`read`, `grep`,
  `find`, `ls`, and bounded `inspect`) under the aggregate review deadline.
  They run in a read-only, zero-network evidence sandbox and cannot
  successfully write, access network, call MCP/custom tools, or request
  nested approval. On Windows, the worker-backed evidence surface is omitted
  until its process-tree cleanup boundary is reliable; the Guardian decides
  from the transcript and action evidence instead.
- The trunk serializes its own reviews. If it is busy, the new review receives
  an **ephemeral fork** from the latest completed trunk snapshot so approval
  requests cannot interleave or contaminate each other.
- A configuration/session/cancellation event, model-resolution change,
  configuration reload, working-directory change, or parent-session reset
  immediately cancels and discards affected review contexts. A permission-mode
  change instead preserves the active permission-turn context until
  `agent_end`, then discards it before the next `agent_start` creates fresh
  context.
- Transport-level provider session reuse is an optimization only; correctness
  comes from the explicitly reconstructed bounded context. This keeps the
  behavior portable across Pi login-backed and custom providers.

Expected evidence failures (for example, a missing path, denied read, or a
wrapped child exiting nonzero) are returned as bounded `isError` evidence and
may be considered by Guardian. Transport/protocol, worker lifecycle, SRT,
cleanup, timeout, crash, authority, and output-bound failures are
infrastructure-fatal: they fail closed and cannot be converted into evidence
that Guardian may approve. If Guardian denies after seeing an expected
evidence error, the denial can be retained as bounded review history.

### Sandbox and network alignment

In `auto`, Bash, native Write, and native Edit remain mediated by
`pi-permissions` under the configured workspace sandbox.

Network behavior remains:

1. Default workspace network is restricted.
2. A request needing external network is classified as an approval request.
3. The exact host/port connection can receive a one-shot sandbox network
   escalation after a Guardian decision; sequential connections require fresh
   review, while concurrent waiters for the same pending request may coalesce.
4. In `auto`, denied hosts, localhost, private/reserved IPs, and metadata
   endpoints stay blocked regardless of Guardian approval. `yolo` retains its
   explicit evaluator-bypass semantics.
5. A denied, timed-out, or failed inline network review aborts the owning
   execution attempt, so no later command segment can continue.

Bash filesystem denial discovered after execution begins is terminal. SRT cannot
prove that earlier command segments had no side effects, so the extension must
not label such a denial safe or replay the command. Native Write/Edit has a
narrower adapter contract: after a runtime denial, the Engine may request one
fresh Guardian decision for the exact normalized file capability and retry only
that single operation. A second denial is terminal, and the retry policy is a
trusted adapter declaration rather than data returned by the executor. The
agent may instead make an explicit `request_permissions` call and submit a
fresh action.

Broader public-network profiles, Unix socket permissions, and local binding
configuration are separate profile work. They must not be introduced as an
implicit side effect of `Auto`.

## Configuration and compatibility

- Existing configurations without `reviewer` retain their current active-model
  behavior.
- `reviewer` contains only model-selection fields. `timeoutMs`, `maxAttempts`,
  and `maxConsecutiveDenials` are removed from the public schema and from the
  example configuration.
- A legacy configuration containing one of those removed policy fields fails
  with a migration message that tells the user to delete it; the extension must
  never silently accept or ignore a policy override.
- `fallbackToActive` is not exposed initially: active-model fallback is the
  fixed Codex-equivalent behavior for an unavailable preferred reviewer.
- The config parser will require `provider` and `model` together, reject
  unknown keys, and never allow project overlays to set `reviewer`.
- `request_permissions` accepts exact network and write capabilities but no
  model-selected lifetime. A successful automatic grant always expires at the
  end of the active permission turn.
- A host embedding the extension may provide a trusted `GuardianPolicySource`
  through `RegisterExtensionOptions`. The source receives only the current
  working directory and configuration fingerprint, returns a complete policy
  string or `undefined`, and is rejected if it is empty or overlong. The
  extension never reads Guardian policy from `PermissionsConfig`, project
  overlays, user messages, tool results, or model output.
- Status output must identify the actual selected reviewer only when it differs
  from the normal active-model path or when a fallback occurs; it must not
  expose API keys, endpoint URLs, or authentication failures verbatim.

## UI behavior

- `Shift+Tab` switches the visible future mode immediately. It does not call
  `ctx.abort()` or alter an in-flight permission-turn snapshot; the next
  `agent_start` uses the then-current reviewer and fresh authorization context.
- `auto` does not open a human approval panel after a Guardian denial or error.
- Reviewer progress must not occupy permanent footer space; only actionable
  non-approved outcomes require a durable notice.
- A preferred-reviewer fallback is surfaced once as a concise extension notice,
  such as `Guardian preferred model unavailable; using active model`.

## Verification plan

Unit and integration coverage must prove:

1. No reviewer config selects the active Pi model.
2. A registered custom reviewer is selected over the active model.
3. Missing custom model and unavailable custom credentials select the active
   model without leaking credential details.
4. An unavailable active model fails closed without opening a human approval
   fallback.
5. Retries occur only for allowed transient/parse failures, use the same model,
   stop at three attempts, and respect a 90-second aggregate deadline.
6. A failed started review never switches to the active model.
7. Trunk reviews serialize; concurrent reviews use isolated forks; cancellation
   and configuration changes invalidate the correct contexts.
8. A denied/failed inline network review aborts the owning process and prevents
   later command effects.
9. A Bash runtime filesystem denial executes exactly once, invokes no reviewer,
   and is never replayed. A native Write/Edit runtime filesystem denial invokes
   one fresh Guardian review and retries the exact file operation at most once;
   a second denial is terminal.
10. Existing configuration, project restriction, mode-switch, circuit-breaker,
    and exact-call authorization tests continue to pass.
11. Guardian approval grants only the exact normalized call, current working
    directory, active turn, and configuration fingerprint; no model-provided
    session scope is accepted.
12. Guardian deny records a denial; `/approve` is exact-action-only and still
    requires a fresh Guardian review.
13. Provider, parse, and timeout failures fail closed in both UI and headless
    Auto; they do not re-open an interactive approval fallback.
14. YOLO is the only path that skips the permission evaluator; Guardian-approved
    Auto calls continue to execute through their captured sandbox snapshot even
    if the future mode is switched to YOLO.
15. Extra Pi Git/private-network hard blocks report as outer Pi policy and are
    never converted into Guardian decisions.
16. Custom-tool actions without MCP metadata are sent as custom tool calls with
    no invented connector/account trust fields.
17. Guardian cannot read a path denied by its parent policy and cannot acquire
    write authority or nested approval.
18. Only user/developer messages, `AGENTS.md`, and host-verified
    `request_user_input` responses can establish authorization; ordinary tool
    results and prior Guardian decisions cannot.
19. MCP remains Reviewer-bypassed by default, with explicit configured rules unchanged.
20. Expected evidence errors may be reviewed, but worker transport/SRT/lifecycle,
    cleanup, timeout, crash, authority, and output-bound failures are terminal
    and cannot reach Guardian approval.
21. Windows does not expose Guardian evidence tools until the worker process
    tree has a reliable cleanup boundary; no unsupported worker or `/bin/bash`
    request is started on that platform.

## Explicit non-goals

- Replacing Pi's provider/login system or storing API keys in this extension.
- Implementing a universal Codex model catalog or a user-configurable copy of
  `auto_review_model_override` metadata.
- Making `Auto` a full-access mode.
- Enabling unrestricted public network as part of this feature.
- Changing the existing default MCP bypass or its explicit configured-rule overrides.
- Changing existing unrelated in-progress source changes.

## Remaining P2 boundaries

- Codex catalog `auto_review_model_override` and provider preferred review
  model metadata are not exposed by the current Pi model registry adapter.
- Pi's retry error taxonomy is behaviorally similar but not identical to
  Codex's Rust classifier.
- Pi's deterministic pre-Guardian Git, protected-path, and private-network hard
  blocks remain an intentional extra safety layer.
- App-server lifecycle and telemetry parity is not part of this P1 change.

## Delivery sequence

1. Bind inline authorization and cancellation to one owned execution attempt;
   keep Bash runtime denials terminal while allowing only the native Write/Edit
   adapter's exact one-shot runtime retry.
2. Remove model-selected session scope so all automatic grants are turn-only.
3. Derive Guardian's sandbox from the parent policy intersected with read-only
   access and carry that policy through the isolated worker boundary.
4. Align trusted evidence wording with the pinned Guardian policy.
5. Run typecheck, focused integration tests, the full suite, Biome, and a final
   Codex-alignment review.

## Permission-turn lifecycle

- `agent_start` creates the authoritative permission-turn snapshot.
- If a `Shift+Tab` transition is still preparing its target sandbox/config,
  `agent_start` waits for that transition. It snapshots only after a successful
  commit; a failed or superseded transition leaves the turn without an
  executable snapshot so tool hooks fail closed.
- `agent_end` closes it, including before a queued continuation where
  `ctx.isIdle()` remains `false`. It preserves recent denial records for
  `/approve`, but clears pending one-shot overrides and all other authorization
  capabilities.
- `agent_settled` is only an outer-run cleanup fallback. It must not delay the
  next turn's snapshot.
- `turn_start` and `turn_end` are model/tool rounds inside a permission turn,
  so they are too granular to define this authorization boundary.
