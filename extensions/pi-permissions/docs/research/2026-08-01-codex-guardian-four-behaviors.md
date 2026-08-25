# Codex Guardian Four-Behavior Audit

**Date:** 2026-08-01

**Scope:** Compare the four previously identified behaviors against the
current `openai/codex` `main` commit `ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff`.
The goal is behavioral parity, not adding stricter Pi-only restrictions.

## 1. Protected paths

Codex's current workspace-root integration tests explicitly establish that
ordinary files and commands can write inside the configured workspace root,
while writes to `.git`, `.agents`, and `.codex` are rejected by the sandbox.
Writes outside the workspace root are also rejected by the sandbox. These are
sandbox enforcement outcomes; they are not automatically Guardian approval
requests.

Pi has the same three metadata directories in
`src/filesystem-policy.ts`, but also adds two Pi-specific protected targets:
the extension package root and
`~/.pi/agent/extensions/pi-permissions/config.json`. Those two additional
hard-protected targets are the clearest candidate for an exact-parity review;
they should not be treated as Codex behavior without separate evidence.

### P2-3 implementation boundary

The two entries have different provenance and should not be removed as one
blind edit:

- `packageRoot` was introduced with the initial filesystem-policy hardening.
  It is a clear Pi-only hard boundary when the extension directory is inside
  the active workspace.
- The plugin-local `config.json` protection was added later specifically to
  protect Pi's own control-plane configuration. It is enforced in three
  places: the default protected-path list, the `isPathAllowed()` fallback,
  and `writeRisk()`'s exact global-config `HARD` classification.

The current Codex checkout has explicit workspace-root tests for
`.git`/`.agents`/`.codex` and outside-root writes, but no equivalent tool-write
hard protection for Codex's own `~/.codex/config.toml` in the audited path.
Therefore the minimal P2-3 decision is:

1. remove `packageRoot` from the Codex-aligned protected set if exact
   workspace-write parity is required;
2. keep the Pi plugin config as a separately documented control-plane guard,
   unless the requirement is literal parity for every possible write target;
3. if literal parity is required, remove the config guard from all three
   enforcement points and add explicit tests for the changed approval outcome.

P2-3A is implemented: `packageRoot` was removed from
`defaultProtectedWritePaths()`, while the plugin config guard remains. The
focused and full Pi tests pass; the post-change decisions are ordinary
workspace and extension-package-root writes `allow`, `.git`/`.agents`/`.codex`
`block`, and the plugin config still `block`.

Codex also instructs Guardian not to assign high/critical risk solely because
a benign local path is outside writable workspace roots. That risk guidance is
separate from the sandbox's ability to deny the write.

## 2. `git push` and private-network targets

Codex does not unconditionally hard-block every `git push`:

- A public, non-allowlisted network target can enter the network approval path.
  With `ApprovalsReviewer::AutoReview`, that approval is represented as a
  Guardian `NetworkAccess` request.
- The Guardian tests also exercise a sandbox-denied public `git push` as a
  `GuardianApprovalRequest::Shell` that can be reviewed.
- Local/private targets such as loopback and RFC1918 IPs are classified as
  `NotAllowedLocal` by the network proxy. That reason is a baseline deny and
  does not go through the network-policy decider or Guardian approval.

Pi's current behavior is therefore directionally aligned:

- public `github.com` Git operations remain prompt/approval-based;
- private or unsupported Git targets are hard-blocked.

The fact that the Pi `git push` path is currently usable is expected and is
not a reason to change it.

## 3. Ordinary workspace commands

Codex has two distinct cases:

1. Under the ordinary restricted sandbox and `OnRequest`/`Granular` approval
   policy, a non-dangerous command within the workspace can execute without an
   approval prompt; the sandbox enforces filesystem and network boundaries.
2. A per-turn `strict_auto_review` grant changes that routing: even a shell
   command whose normal approval requirement is `Skip` is sent to Guardian.
   Codex's regression test demonstrates this with `echo hi` under an otherwise
   disabled approval profile.

Pi's ordinary low-risk command path also returns `allow` without Guardian.
Its `auto` mode reviews requests that the default evaluator marks as
`prompt`; it should not be compared directly with Codex's separate
per-turn `strict_auto_review` grant. Any parity change here requires a
dedicated Pi lifecycle fixture for that grant semantics, not a blanket rule
that all ordinary workspace commands must be Guardian-reviewed.

## 4. Guardian provider failures

Codex retries only these review outcomes:

1. `Session` with `ServerOverloaded`;
2. `Session` with `HttpConnectionFailed`;
3. `Session` with `ResponseStreamConnectionFailed`;
4. `Session` with `InternalServerError`;
5. `Session` with `ResponseStreamDisconnected`;
6. `Parse` errors.

Prompt-build failures, untyped session failures, client/auth failures,
timeouts, and cancellations are not retried. Pi's P2-2 implementation in
commit `15cac0a` now matches this retry eligibility boundary while retaining
the Pi provider API and existing 90-second/three-attempt lifecycle.

## Sources

- [Codex Guardian review loop and retry classifier](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/core/src/guardian/review.rs)
- [Codex workspace-root tests](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/core/tests/suite/workspace_roots.rs)
- [Codex Guardian policy](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/core/src/guardian/policy.md)
- [Codex network-proxy host policy](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/network-proxy/src/runtime.rs)
- [Codex network-policy decision boundary](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/network-proxy/src/network_policy.rs)
- [Codex network approval flow](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/core/src/tools/network_approval.rs)
- [Codex strict auto-review test](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/core/src/session/tests/guardian_tests.rs)
