# Config path: agentDir/permissions.json (npm-install safe)

## Scope

- Date: 2026-09-14
- Codex pin: `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- Host pin: `@earendil-works/pi-coding-agent@0.85.1`

## Problem

`loadPermissionsConfig` hardcoded `join(agentDir, "extensions", "pi-permissions",
"config.json")`. After `pi install npm:...` the extension code lives in
`~/.pi/agent/npm/node_modules/<pkg>/`, so that path misses and the session
silently uses `DEFAULT_CONFIG`.

## Decision

Canonical user config is `{agentDir}/permissions.json` (agentDir root fixed
name), aligned with community practice (`carderne/pi-sandbox`,
`pi-web-access`, official sandbox examples).

Resolution order:

1. `{agentDir}/permissions.json` — wins when present; invalid JSON is a setup
   error, never a silent fallback
2. `{agentDir}/extensions/pi-permissions/config.json` — read-only legacy
   fallback + one-shot deprecation notify
3. `DEFAULT_CONFIG`

Both paths are in `defaultProtectedWritePaths` so a delete-new-fallback
scenario cannot become an agent self-privilege bypass.

`filesystem-policy.ts` `defaultAgentDir()` now honors `PI_CODING_AGENT_DIR`,
matching the official `getAgentDir()` contract.

Fingerprint continues to bind content only; path is status-only.

## What this note does not claim

- No project-level `.pi/permissions.json` overlay (trust boundary; would need
  restrict-only design).
- No automatic file migration or runtime write-back.
- No `import.meta.url` user-config path (community pattern is agentDir fixed
  names).
- Legacy path protection remains until a future major.

## Product contract tests

`tests/config-path.test.ts`: new-only, legacy-only, default, both-present
(new wins), invalid-new no-fallback, `PI_CODING_AGENT_DIR`, dual protected
paths, path-independent fingerprint.

## Acceptance

`check`, `lint`, `test` (1118 passed / 1 skipped).
`check:host-turn-boundary` not required.
