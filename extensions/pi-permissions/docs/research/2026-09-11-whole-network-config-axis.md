# Whole-network under Approve for me (config axis)

## Scope

- Date: 2026-09-11
- Codex pin: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- Host pin: `@earendil-works/pi-coding-agent@0.85.1`
- pi-permissions revision under discussion: local main (see commit that lands this note)
- Sibling `pi-core` is not pinned; acceptance is a revision pair.

## Decision

Keep whole-network authority on the **config** axis only:
`sandbox.network.enabled`. Do not bake it into auto mode, do not change
`DEFAULT_CONFIG`, and leave yolo as the only unrestricted path.

Codex separates two orthogonal axes:

1. Network capability: `sandbox_workspace_write.network_access`
   (`NetworkSandboxPolicy::Restricted` default / `Enabled`).
2. Who reviews: `approvals_reviewer` `user` vs `auto_review`.

`auto_review` does not imply whole network. NetworkAccess approvals amend a
single host into the proxy allowlist; they do not flip policy to Enabled.
`Feature::NetworkProxy` is experimental and default-off. With Enabled and no
proxy, seatbelt is a true full-network open (outbound and inbound). With
Enabled and proxy, allowlist misses still ask.

Our `network.enabled=true` maps only to the capability short-circuit:
inline `authorizeCapability` accepts any host that is public and not denied
once `requestCovered` sees base `network.enabled === true`; private/special
targets are filtered earlier in `authorizeInlineCapability` and stay
hard-blocked unless an exact local allow, `allowLocalBinding`, or
`allowPrivateTargets` is configured. Production still runs the
connect-guard and forces SRT `allowedDomains` empty
(`sandbox/srt-enforcer.ts`).

This is **not** Codex "Enabled+proxy" (that still reviews misses). It is a
deliberate stricter hybrid: public hosts skip review, private stays blocked,
connect-guard always binds DNS.

## What this note does not claim

- No claim that auto mode grants whole network.
- No claim that private targets are allowed under `enabled: true`.
- No claim that delegated children inherit whole-network authority
  (`delegation.ts` pins child `enabled: false` + `delegated: true`).
- No native SRT/seatbelt isolation proof; contract tests are hermetic Engine
  tests.
- No claim that Codex default is whole-network; Codex default is Restricted
  (sandbox has no network until `network_access = true`).

## Product contract tests

`tests/approve-for-me-engine.test.ts`:

- config-level `enabled: true` + public host → authorize allow, no review
- config-level `enabled: true` + private host → `policy-denied`, no review

## Acceptance for this slice

`preflight:sibling`, `check`, `lint`, `test`. Not a mid-turn/lifecycle slice:
`check:host-turn-boundary` is not required.
