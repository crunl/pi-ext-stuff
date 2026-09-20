# `network_access`: whole-open TCP network (Codex Enabled analogue)

## Scope

- Date: 2026-09-12
- Codex pin: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- Host pin: `@earendil-works/pi-coding-agent@0.85.1`
- Retires `2026-09-11-whole-network-config-axis.md` (old `enabled` public-only semantics).

## Decision

Replace `sandbox.network.enabled` with Codex-named `sandbox.network.network_access`.

`network_access: true` = whole TCP network open (Codex Enabled without proxy):
public + private outbound + loopback + bind/inbound. Unix sockets are a
**separate OS axis** — config surface shipped in `2026-09-19-unix-sockets-srt-allowlist.md`
(A2); `network_access` still does not open AF_UNIX. Fine axes remain:

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

## Intentional divergences from Codex

1. **Fine-axis tightening.** Codex `network_access:true` (no managed proxy)
   already opens bind/inbound at the seatbelt layer; `allow_local_binding` is
   only a `NetworkProxyConfig` axis, not a workspace-write axis. Our
   `network_access:true` therefore **aligns** with Codex Enabled-direct. The
   product extension is that `allowPrivateTargets` / `allowLocalBinding` may
   explicitly tighten that expanded authority (Codex has no workspace-write
   equivalent).
2. **Tool vocabulary.** Codex `RequestPermissionsArgs.permissions.network` is
   `NetworkPermissions { enabled?: boolean }`. Our tool and config share one
   word: `network_access`. Schema and runtime must stay identical.

## Static config + system TLS

`network_access: true` + `macosTls: "system"` is rejected at load because the
expanded localBinding conflicts with helper egress. Granting whole-network at
runtime on a system-TLS baseline pins `allowLocalBinding: false` for that
lease. To keep a static system-TLS profile, set
`allowLocalBinding: false` alongside `network_access: true`.

## What this note does not claim

- No claim that auto mode is yolo; auto still only Guardian-reviews.
- No claim that connect-guard or `deniedDomains` are relaxed.
- No claim that unix sockets are authorized by `network_access`; they require
  `allowUnixSockets` / `dangerouslyAllowAllUnixSockets` (see
  `2026-09-19-unix-sockets-srt-allowlist.md`).
- No claim that bind is independently configurable beyond `allowLocalBinding`.
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
- `request_permissions` registered schema exposes `network_access`, not `enabled`
- `effectiveNetworkAuthority` true/false/undefined × fine axes

## Acceptance for this slice

`check`, `lint`, `test` (1100 passed / 1 skipped). `preflight:sibling` reported
dirty sibling (`pi-core@7a26af7` with local WIP) — not a clean-pair acceptance.
`check:host-turn-boundary` not required (no mid-turn/lifecycle change).
