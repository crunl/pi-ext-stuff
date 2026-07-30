# YOLO Full Access mode design

**Status:** approved for planning
**Date:** 2026-07-30
**Scope:** `pi-permissions` only

## Goal

Add a `YOLO` mode that matches the permission semantics of Codex CLI's
**Full Access** preset:

- never ask the user for approval;
- never invoke Guardian;
- do not apply the extension sandbox to Bash, Write, or Edit and do not
  intercept native Read or other tools with permission policy;
- do not apply `pi-permissions` risk rules or hard blocks;
- allow filesystem and network access subject only to the Pi process, host
  operating system, and external service constraints.

`YOLO` is a permission profile, not a third approval reviewer. `Default` and
`Auto` retain their existing workspace sandbox and differ only in who reviews
approval requests.

## Codex behavior being matched

Codex's built-in Full Access preset combines:

- approval policy `Never`;
- disabled permission profile rather than a managed filesystem sandbox;
- unrestricted network at the Codex permission layer.

Codex's TUI normally presents a Full Access warning. Pi deliberately will not
show that confirmation because the requested product behavior is direct mode
switching.

Primary references:

- [Built-in approval presets](https://github.com/openai/codex/blob/main/codex-rs/utils/approval-presets/src/lib.rs)
- [Codex permission popup flow](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/permission_popups.rs)

## Product decisions

### Permission model

| Mode | Policy evaluation | Approval reviewer | Effective sandbox | Network |
|---|---|---|---|---|
| `Default` | enabled | user | configured workspace profile | configured allowlist and one-call escalation |
| `Auto` | enabled | Guardian, with existing human fallback | same configured workspace profile | same configured allowlist and one-call escalation |
| `YOLO` | bypassed | none | off for execution | unrestricted by `pi-permissions` |

The configured sandbox remains the base profile for `Default` and `Auto`.
Entering `YOLO` does not mutate or erase that configuration.

### Mode entry and cycling

The mode cycle is:

```text
Default -> Auto -> YOLO -> Default
```

- `Shift+Tab` advances one step immediately.
- `/default`, `/auto`, and `/yolo` activate the named mode immediately.
- No warning or confirmation panel is shown when entering `YOLO`.
- A mode change invalidates pending reviews, approval grants, temporary
  filesystem/network grants, and Guardian denial overrides.
- The bottom border continues to hide `Default` and displays non-default modes
  as `Auto` or `YOLO`.

The status command describes YOLO as:

```text
YOLO · Full Access · sandbox off · approvals never
```

### Tool-call authorization path

For `Default` and `Auto`, the existing flow remains unchanged:

1. Load and validate the global configuration.
2. Classify the request.
3. Allow, hard-block, or obtain the appropriate approval.
4. Bind any approval to the exact call, working directory, mode, and
   configuration fingerprint.
5. Revalidate at execution time.
6. Execute through sandboxed Bash, Write, or Edit operations.

For `YOLO`:

1. Load and validate the global configuration.
2. Read the active mode.
3. Skip classification, rules, hard blocks, approval state, Guardian, and
   one-call escalation bookkeeping.
4. Execute overridden Bash, Write, and Edit through their Pi-native backends;
   allow native Read and other tools to continue without extension policy.

The YOLO path must be selected at both `tool_call` interception and tool
execution. This prevents a call admitted under YOLO from executing after the
mode has already returned to `Default` or `Auto`.

### Switching while work is active

Mode changes affect future execution decisions and do not retroactively alter
an operation that has already started:

- An already-running sandboxed operation remains sandboxed after switching to
  `YOLO`.
- An already-running native YOLO operation is not terminated or moved into a
  sandbox after switching away.
- A call admitted under YOLO but not yet executing must pass the current
  `Default`/`Auto` authorization gate if the mode changes before execution.
- A previously approved `Default`/`Auto` call may execute natively if the
  active mode has become YOLO, because the current boundary is broader.

The existing mode-mutation queue and permission-context epoch remain the
serialization mechanism. The sandbox manager may stay initialized but dormant
while YOLO is active; native execution must not use its operations. Avoiding a
reset on entry prevents disruption of an in-flight sandboxed command.

### Sandbox availability

YOLO must not depend on successful sandbox initialization:

- If a session starts with `defaultMode: "yolo"`, a missing or unsupported
  sandbox runtime must not prevent native execution.
- Switching from YOLO to `Default` or `Auto` initializes the configured
  sandbox before committing the mode change.
- If that initialization fails, the transition fails and the active mode
  remains YOLO.
- Switching into YOLO remains available when the sandbox is unavailable,
  provided the global configuration itself is valid.

“Unrestricted network” means that `pi-permissions` does not filter hosts or
inject its filtering proxy. The native process can still be affected by its
environment variables, host firewall, DNS, credentials, upstream proxy, or
remote service policy.

## Single global configuration source

The only configuration source is:

```text
~/.pi/agent/extensions/pi-permissions/config.json
```

The loader will no longer read `<project>/.pi/permissions.json`, regardless of
project trust. Remove project overlays, project expansions, restrictive merge
logic, and the associated `projectTrusted` input.

Project `.pi/permissions.json` files are ignored rather than deleted. Because
they are no longer permission-control files, remove their special protected
path and hard-risk classification. The global `config.json` remains protected
under `Default` and `Auto`; YOLO intentionally bypasses that protection.

Configuration content is global, but sandbox materialization remains scoped
to the active working directory because relative write roots and protected
workspace paths must still resolve against that directory in Default/Auto.

The global schema accepts:

```json
{
  "defaultMode": "yolo"
}
```

A new session uses the configured default. The active mode remains persisted
inside its Pi session and is restored only when its configuration fingerprint
still matches.

## State and compatibility

- Extend `PermissionMode` and configuration validation with `yolo`.
- Preserve existing `default`, `auto`, and dormant `plan` state compatibility.
- Extend session-state validation so existing saved states remain readable.
- `modeBeforePlan`, if retained while Plan is unimplemented, may include all
  executable modes that Plan can return to.
- Auto-only counters and Guardian state remain stored but inactive in YOLO.
- A malformed global configuration still fails closed; YOLO does not bypass
  configuration parsing.
- Existing `sandbox.enabled: false` remains supported, but it is independent of
  the mode. It disables sandbox execution for Default/Auto as it does today;
  YOLO always uses native execution regardless of this field.

## UI behavior

- Status label type becomes `Default | Auto | YOLO`.
- Default remains absent from the compact bottom border.
- Auto and YOLO are displayed in the existing statusline slot without adding
  another status component.
- Mode switching uses the existing concise mode-change notification behavior;
  there is no Full Access confirmation popup.
- Default approval-panel wording and Auto denial/override UI are unchanged.

## Verification plan

Tests must prove:

1. The configuration schema accepts `defaultMode: "yolo"` and rejects unknown
   mode values.
2. Only the global `config.json` is read.
3. A syntactically invalid project `.pi/permissions.json` is ignored.
4. Project settings cannot alter mode, reviewer, rules, filesystem roots, or
   network domains.
5. The cycle order and named commands are
   `Default -> Auto -> YOLO -> Default`.
6. YOLO does not call the risk evaluator, human approval UI, Guardian,
   approval ledger, filtering proxy, or sandbox operations.
7. YOLO Bash, Write, and Edit use their native backends, while native Read and
   other tools pass through without extension policy.
8. Reads, writes, commands, and hosts that are hard-blocked in Default/Auto
   execute through the YOLO authorization path.
9. Switching away from YOLO before execution requires fresh authorization
   under the new mode.
10. Switching during an already-running operation does not change that
    operation's execution backend.
11. A YOLO-default session works when sandbox initialization would fail.
12. A transition from YOLO to Default/Auto commits only after successful
    sandbox initialization.
13. Pending Guardian and human approval context is invalidated on every mode
    transition.
14. `/permissions` and bottom-border rendering report YOLO correctly.
15. Existing Default and Auto tests continue to pass unchanged in behavior.

Verification commands:

```text
pnpm test
pnpm exec tsc --noEmit
pnpm exec biome check <touched files>
```

## Explicit non-goals

- Adding a Full Access confirmation panel.
- Applying a reduced set of “absolute” hard blocks in YOLO.
- Sandboxing user-initiated `!bash`, which is outside this extension's mediated
  agent-tool path.
- Deleting project-owned `.pi/permissions.json` files from arbitrary
  repositories.
- Changing Guardian prompt, model selection, retry policy, or circuit breaker.
- Implementing Plan mode.

## Delivery sequence

1. Simplify configuration loading to the single global source and remove
   project-config protection/classification.
2. Add YOLO to configuration, state, mode runtime, cycle order, commands, and
   status rendering.
3. Introduce an effective execution-profile decision that selects sandboxed
   or native tool backends without weakening Default/Auto.
4. Make sandbox initialization conditional on the effective mode and preserve
   atomic transitions out of YOLO.
5. Add race, bypass, configuration, UI, and regression tests.
6. Run strict Biome formatting/lint, TypeScript checking, and the full test
   suite.
