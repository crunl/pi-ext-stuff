# `network_access`: whole-open TCP network (Codex Enabled analogue)

## Scope

- Date: 2026-09-12
- Codex pin: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- Host pin: `@earendil-works/pi-coding-agent@0.85.1`
- Retires `2026-09-11-whole-network-config-axis.md` (old `enabled` public-only semantics).

## Decision

Replace `sandbox.network.enabled` with Codex-named `sandbox.network.network_access`.

`network_access: true` = whole TCP network open (Codex Enabled without proxy):
public + private outbound + loopback + bind/inbound. Unix sockets stay a separate
future axis. Fine axes remain:

| Field | Role |
|---|---|
| `allowPrivateTargets` | explicit false tightens private outbound |
| `allowLocalBinding` | explicit false tightens bind/inbound |
| `deniedDomains` | always vetoes |
| `allowedDomains` | exact allows when whole-network is off |

Expansion is derived at runtime by `effectiveNetworkAuthority()`; values are
**not** materialized back into policy fields (fingerprint, delegation, status).

Delegated children pin `network_access: false` + `allowLocalBinding: false`;
they inherit only an **explicit** parent `allowPrivateTargets: true`, never the
expanded authority.

The old field `sandbox.network.enabled` is removed. Load throws a dedicated
migration ConfigError. `request_permissions` tool shape uses the same
`network_access: true` name.

## What this note does not claim

- No claim that auto mode is yolo; auto still only Guardian-reviews.
- No claim that connect-guard or `deniedDomains` are relaxed.
- No claim that unix sockets or bind are independently configurable beyond
  `allowLocalBinding`.
- No native SRT isolation proof; contract tests are hermetic Engine/config tests.
- Sibling `pi-core` was dirty during local acceptance; pair results are
  provisional until a clean sibling run.

## Product contract tests

- `network_access: true` + public host → allow, no review
- `network_access: true` + private host → allow, no review
- `network_access: true` + denied host → policy-denied
- `network_access: true` + explicit `allowPrivateTargets: false` → private denied
- config load of `enabled` → dedicated migration error
- `network_access: true` + direct → no longer requires separate private flag

## Acceptance for this slice

`check`, `lint`, `test` (1100 passed / 1 skipped). `preflight:sibling` reported
dirty sibling (`pi-core@7a26af7` with local WIP) — not a clean-pair acceptance.
`check:host-turn-boundary` not required (no mid-turn/lifecycle change).
