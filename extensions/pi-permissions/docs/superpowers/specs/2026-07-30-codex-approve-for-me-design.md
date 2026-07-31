# Codex-equivalent Approve for Me design

**Status:** approved for planning
**Date:** 2026-07-30
**Scope:** `pi-permissions` only

## Goal

Make Pi's `Auto` mode behaviorally equivalent to Codex CLI's **Approve for
me** preset:

- `Default` and `Auto` have the same `on-request`/workspace permission
  boundary.
- The only mode-level difference is the approval reviewer: user in `Default`,
  Guardian in `Auto`.
- Guardian is a non-mutating, isolated review session. It can approve or deny
  a request; it cannot execute tools or grant itself further permissions.
- A configured custom Guardian model is preferred, but a missing model or
  unavailable Pi credential falls back to Pi's current active model.

This is a behavioral alignment, not a copy of Codex's Rust implementation or
its proprietary model catalog.

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

Primary references:

- [Guardian selection and retries](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review.rs)
- [Guardian timeout and circuit breaker](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/mod.rs)
- [Provider preferred review model](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/provider.rs)
- [Read-only reusable Guardian session](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review_session.rs)

## Product decisions

### Modes and permission boundary

| Mode | Approval reviewer | Filesystem sandbox | Network policy | Hard blocks |
|---|---|---|---|---|
| `Default` | User | Workspace | Restricted; escalation needed | Always block |
| `Auto` | Guardian | Same Workspace profile | Same restricted policy | Always block |

Neither switching to `Auto` nor accepting a Guardian approval may broaden the
sandbox. The required `Allow Once` and `Allow, switch future approvals to
Auto` flows grant only the exact approved action.

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
4. If the active model is unavailable too, do not approve: return the request
   to the human approval path.

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
| maximum three attempts or 90-second deadline reached | fail closed to human approval |
| cancellation or config/session change | invalidate the old review and require fresh approval |
| permission-mode change | keep the in-flight permission turn's snapshot; apply the selected mode and fresh approval context at its next `agent_start` without aborting the outer agent run |
| Guardian deny | deny the action and update the existing circuit breaker |
| Guardian allow | grant only the exact normalized call and config fingerprint |

Permission-mode transitions have one uniform turn-snapshot rule: every change is
future-effective. An exact in-flight call retains the mode, configuration, and
approval context captured for its permission turn. After `agent_end`, the next
`agent_start` captures the selected mode and receives fresh approval context,
even if a queued continuation begins while Pi still reports working. This does
not reuse a stale approval, broaden a call, or apply to config/session
invalidations; those paths remain fail-closed.

There is deliberately no second-model fallback after a request has started.
That avoids hidden policy changes, duplicate long waits, and accidental extra
provider cost. This matches Codex's same-model retry/fail-closed behavior.

The following are Guardian policy constants, not deployment configuration:

| Constant | Value | Codex-equivalent purpose |
|---|---:|---|
| `GUARDIAN_REVIEW_TIMEOUT_MS` | 90,000 | One aggregate review deadline |
| `GUARDIAN_REVIEW_MAX_ATTEMPTS` | 3 | Same-model retry limit inside that deadline |
| `MAX_CONSECUTIVE_GUARDIAN_DENIALS` | 3 | Pause the Auto turn after repeated denials |
| `MAX_RECENT_GUARDIAN_DENIALS` | 10 in 50 reviews | Secondary denial circuit breaker |

They are deliberately hard-coded. Exposing them in `config.json` would let a
local configuration silently diverge from Codex approval semantics.

### Guardian review-session manager

Introduce a `GuardianReviewSessionManager` owned by each Pi agent session.

- It owns one reusable **trunk** review context keyed by the active Pi session,
  resolved reviewer model, configuration fingerprint, and working directory.
- The trunk has a stable Guardian system prompt, bounded prior review context,
  no tools, no skills, no memories, and no inherited execution permissions.
- The trunk serializes its own reviews. If it is busy, the new review receives
  an **ephemeral fork** from the latest completed trunk snapshot so approval
  requests cannot interleave or contaminate each other.
- A mode change, model resolution change, configuration reload, working
  directory change, or parent-session reset cancels and discards affected
  review contexts.
- Transport-level provider session reuse is an optimization only; correctness
  comes from the explicitly reconstructed bounded context. This keeps the
  behavior portable across Pi login-backed and custom providers.

Pi's Guardian has no tools at all. This is at least as restrictive as Codex's
read-only sandboxed Guardian session and avoids an additional filesystem or
network execution surface for the reviewer.

### Sandbox and network alignment

`Default` and `Auto` both use the same configured workspace sandbox. Bash,
native write, and native edit remain mediated by `pi-permissions`.

Network behavior remains:

1. Default workspace network is restricted.
2. A request needing external network is classified as an approval request.
3. The exact call can receive a one-call sandbox network escalation after a
   user or Guardian decision.
4. Denied hosts, localhost, private/reserved IPs, and metadata endpoints stay
   blocked regardless of mode or approval reviewer.

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
- Status output must identify the actual selected reviewer only when it differs
  from the normal active-model path or when a fallback occurs; it must not
  expose API keys, endpoint URLs, or authentication failures verbatim.

## UI behavior

- `Shift+Tab` switches the visible future mode immediately. It does not call
  `ctx.abort()` or alter an in-flight permission-turn snapshot; the next
  `agent_start` uses the then-current reviewer and fresh authorization context.
- The bottom border displays a non-default mode only, preserving the existing
  compact status-line convention.
- `Allow, switch future approvals to Auto` grants the current exact call as a
  human-approved call, then changes future approval ownership to Guardian.
- A preferred-reviewer fallback is surfaced once as a concise extension notice,
  such as `Guardian preferred model unavailable; using active model`.

## Verification plan

Unit and integration coverage must prove:

1. No reviewer config selects the active Pi model.
2. A registered custom reviewer is selected over the active model.
3. Missing custom model and unavailable custom credentials select the active
   model without leaking credential details.
4. An unavailable active model returns a human approval requirement.
5. Retries occur only for allowed transient/parse failures, use the same model,
   stop at three attempts, and respect a 90-second aggregate deadline.
6. A failed started review never switches to the active model.
7. Trunk reviews serialize; concurrent reviews use isolated forks; cancellation
   and configuration changes invalidate the correct contexts.
8. `Default` and `Auto` resolve to identical sandbox and network settings.
9. Hard filesystem/network blocks remain blocked under `Auto`.
10. Existing configuration, project restriction, mode-switch, circuit-breaker,
    and exact-call authorization tests continue to pass.

## Explicit non-goals

- Replacing Pi's provider/login system or storing API keys in this extension.
- Implementing a universal Codex model catalog or a user-configurable copy of
  `auto_review_model_override` metadata.
- Making `Auto` a full-access mode.
- Enabling unrestricted public network as part of this feature.
- Changing existing unrelated in-progress source changes.

## Delivery sequence

1. Add resolver/config schema and tests.
2. Add same-model retry/deadline/error routing and tests.
3. Add Guardian trunk/fork session manager and lifecycle integration.
4. Wire concise UI fallback reporting and confirm mode/sandbox invariants.
5. Run typecheck, full test suite, focused manual TUI checks, and a final
   Codex-alignment review.

## Permission-turn lifecycle

- `agent_start` creates the authoritative permission-turn snapshot.
- `agent_end` closes it, including before a queued continuation where
  `ctx.isIdle()` remains `false`.
- `agent_settled` is only an outer-run cleanup fallback. It must not delay the
  next turn's snapshot.
- `turn_start` and `turn_end` are model/tool rounds inside a permission turn,
  so they are too granular to define this authorization boundary.
