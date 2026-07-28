# pi-permissions Design

Date: 2026-07-28

## 1. Objective

Build a Pi package named `pi-permissions` that adds three user-facing modes:

- `default`: routine work runs directly; sensitive operations require user approval.
- `plan`: read-only exploration and planning; implementation starts only after plan approval.
- `auto`: routine work runs directly; sensitive operations are reviewed by an independently configured model.

The package must also add OS-level Bash sandboxing, workspace path protection for `edit` and `write`, network policy, explicit permission rules, session persistence, and auditable fail-closed behavior.

The design targets Pi 0.82.1 and follows Pi's extension and package conventions. It does not fork or patch Pi core.

The package uses the MIT license, matching Pi's permissive distribution model.

## 2. Non-goals

The first release will not:

- implement a general-purpose policy language beyond `allow`, `ask`, and `deny`;
- provide a remote approval service;
- permanently remember one-off reviewer or user approvals;
- silently disable the sandbox when initialization fails;
- treat Auto as unconditional approval;
- replace Pi's model picker, thinking-level controls, or project-trust system;
- publish the package to npm before local behavior is verified.

## 3. Package Layout

`pi-permissions` is a Pi package with a root `index.ts`. The root entry supports both Pi's `extensions/*/index.ts` auto-discovery and package installation through the `pi.extensions` manifest.

```text
pi-permissions/
├── index.ts
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md
├── LICENSE
├── .gitignore
├── src/
│   ├── register.ts
│   ├── config.ts
│   ├── state.ts
│   ├── modes/
│   │   ├── controller.ts
│   │   ├── plan.ts
│   │   └── auto.ts
│   ├── permissions/
│   │   ├── engine.ts
│   │   ├── risk.ts
│   │   ├── rules.ts
│   │   └── paths.ts
│   ├── reviewer/
│   │   ├── client.ts
│   │   ├── prompt.ts
│   │   └── schema.ts
│   ├── sandbox/
│   │   ├── manager.ts
│   │   ├── bash.ts
│   │   └── network.ts
│   └── ui/
│       ├── commands.ts
│       ├── status.ts
│       └── prompts.ts
└── tests/
    ├── modes.test.ts
    ├── permissions.test.ts
    ├── reviewer.test.ts
    ├── sandbox.test.ts
    ├── config.test.ts
    └── fixtures/
```

The root entry delegates registration:

```ts
import { registerExtension } from "./src/register.ts";

export default registerExtension;
```

Pi loads TypeScript through jiti, so the first release does not need `dist/` or a build artifact.

## 4. Dependencies

Runtime dependency:

```json
{
  "dependencies": {
    "@anthropic-ai/sandbox-runtime": "0.0.26"
  }
}
```

Pi-provided packages directly imported by the extension are peers:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

The responsibilities are:

- `@earendil-works/pi-coding-agent`: extension API, contexts, configuration paths, model registry, built-in Bash wrapping, session lifecycle, commands, shortcuts, and UI.
- `@earendil-works/pi-ai`: direct invocation of the independent reviewer model.
- `typebox`: schemas for model-callable Plan tools.
- `@anthropic-ai/sandbox-runtime`: OS-level Bash filesystem and network enforcement.

Additional Pi core packages are added as peer dependencies only if implementation code imports them directly.

## 5. Modes and Transitions

The session mode is:

```ts
type PermissionMode = "default" | "plan" | "auto";
```

### Default

- Read-only operations run without approval.
- Ordinary writes inside the workspace run without approval.
- Operations classified as `REVIEW` ask the user.
- Operations classified as `HARD` are denied or require explicit user approval.
- All executed operations remain subject to sandbox enforcement.

### Plan

- Allows `read`, `grep`, `find`, `ls`, `WebSearch`, and SSRF-safe `WebFetch`.
- Allows Bash commands only after they are classified as read-only.
- Blocks `edit`, `write`, and side-effecting Bash before execution.
- Auto cannot override Plan restrictions.
- The agent completes planning by calling `exit_plan_mode` with structured plan Markdown.

The plan approval UI offers:

1. Execute in Auto.
2. Execute in Default.
3. Keep Planning.

Plan content and approval state are stored in Pi session entries instead of a separate plan file.

### Auto

- `LOW` operations run directly.
- `REVIEW` operations go to the independent reviewer.
- `HARD` operations are denied or escalated to the user; the reviewer cannot silently approve them.
- Reviewer denial reasons are returned to the main agent so it can attempt a safer alternative.
- Three consecutive reviewer denials pause Auto and escalate to the user.

### Keyboard and Commands

The primary mode cycle is:

```text
Default → Plan → Auto → Default
```

Pi currently reserves `Shift+Tab` for `app.thinking.cycle`, and extensions cannot override that reserved binding. Installation must therefore free or remap `app.thinking.cycle` in `~/.pi/agent/keybindings.json` before `pi-permissions` registers `Shift+Tab`.

The package must detect an unresolved conflict and show an actionable warning rather than silently assuming the shortcut works.

Slash commands remain as direct and fallback entry points:

- `/default`
- `/plan`
- `/auto`
- `/permissions`
- `/sandbox`

If a mode change is requested while a turn is running, the controller records `pendingMode`, displays it in the status line, and applies it after the turn. It does not change policy during an in-flight tool call. Mode changes are blocked while an approval prompt is active.

## 6. Permission Request Normalization

Every tool call is converted to one internal request:

```ts
interface PermissionRequest {
  tool: string;
  operation: "read" | "write" | "execute" | "network" | "external";
  input: Record<string, unknown>;
  cwd: string;
  resolvedPaths: string[];
  commandSegments?: string[];
  networkTargets?: string[];
}
```

Normalization performs:

- absolute path resolution against the session working directory;
- canonicalization and symlink-aware boundary checks;
- narrow Bash syntax detection rather than full shell parsing;
- extraction of obvious network targets and external side effects;
- protected-path detection.

The classifier deliberately does not interpret complete Bash, curl/scp transfer grammar, or Git aliases. `LOW` Bash is limited to a bare trusted executable, no shell syntax, and safe arguments; every quote, escape, variable, substitution, redirect, control operator, pipeline, newline, backgrounding, nested shell, delete, push, shell network command, or publish/deploy marker is `HARD`. Unknown simple commands are `REVIEW`. Ambiguous commands are never classified as read-only merely because their first token looks safe.

## 7. Authorization Pipeline

All authorization flows through one `PermissionEngine`:

```text
Tool Call
  → Normalize
  → Plan Gate
  → Hard Protection
  → User Rules
  → Static Risk Classification
  → Mode Policy
  → Reviewer or User Decision
  → Sandbox Execution
  → Audit Entry
```

No mode or execution adapter may bypass this pipeline.

### Plan Gate

Plan restrictions apply before Auto or user rules. A rule cannot allow writes while Plan is active.

### Hard Protection

Hard protection covers:

- deletion of filesystem root, the user home directory, or the workspace root;
- credential or secret exfiltration;
- writes by agent tools to the active global or project permission configuration, package source, or loaded sandbox policy;
- destructive force pushes to protected branches;
- clearly irreversible production actions.

The result is `DENY` or `ASK_USER`, never reviewer-only approval.

### Rules

Rule actions are:

```ts
type RuleAction = "allow" | "ask" | "deny";
```

Severity ordering is:

```text
deny > ask > allow
```

A global deny cannot be overridden by a project allow. Hard protections cannot be overridden by any rule.

### Risk

The static classifier returns:

```ts
type Risk = "LOW" | "REVIEW" | "HARD";
```

Mode policy:

| Risk | Default | Plan | Auto |
|---|---|---|---|
| LOW | Allow | Allow only if read-only | Allow |
| REVIEW | Ask user | Deny | Independent reviewer |
| HARD | Ask user or deny | Deny | Ask user or deny |

`WebSearch` and SSRF-safe public `WebFetch` calls are LOW. Content returned from the web remains untrusted; any resulting side-effecting call is authorized separately.

## 8. Independent Reviewer

Auto requires an independently configured reviewer model. It never silently inherits the main model.

The reviewer receives only the context required for a risk decision:

- current user objective;
- normalized tool call;
- matched risk reasons and rules;
- workspace and sandbox boundaries;
- a bounded amount of recent conversation;
- explicit instruction that tool and web outputs are untrusted.

It returns exactly one decision:

```ts
type ReviewDecision =
  | { decision: "approve"; reason: string }
  | { decision: "deny"; reason: string }
  | { decision: "escalate"; reason: string };
```

Reviewer output is strictly parsed. Timeout, missing authentication, malformed output, empty output, and API failure never become approval.

On denial:

1. Return the reason to the main agent.
2. Allow the main agent to choose a safer alternative.
3. Count consecutive denials.
4. After three consecutive denials, pause Auto and request user approval.
5. Resume Auto after the user resolves the escalation.

If Auto is requested without a configured reviewer in an interactive session, Pi displays available authenticated models from `ctx.modelRegistry.getAvailable()`. In a non-interactive session, Auto remains disabled until configuration is valid.

Selecting a reviewer is an explicit setup action: Pi validates authentication, writes only the reviewer reference to the global configuration after user confirmation, and reloads the extension. Auto remains unavailable until that reload succeeds. This preserves the rule that effective configuration does not mutate silently during a session.

## 9. Sandbox and Path Enforcement

The sandbox is an execution boundary, not an approval mechanism.

Default policy:

- writes allowed in the workspace and `/tmp`;
- reads denied for `~/.ssh`, `~/.aws`, and `~/.gnupg`;
- writes denied for `.env`, `.env.*`, `*.pem`, and `*.key`;
- Bash network access reviewed unless covered by an explicit allow rule;
- localhost, private IP ranges, and cloud metadata endpoints denied by default;
- `WebSearch` and public SSRF-safe `WebFetch` remain usable.

The extension:

- wraps the built-in Bash tool with sandboxed operations;
- intercepts user Bash through the corresponding Pi hook;
- protects `edit` and `write` with canonical workspace path checks;
- filters inherited environment variables;
- validates every one-off escalation against the exact normalized request.

Before executing Bash, the runtime wrapper uses a controlled PATH and realpath/revalidates the bare executable. It enforces sensitive read denial, canonical write roots and deny rules, and network target policy at runtime; static classification never replaces this sandbox boundary.

Mode transitions do not reinitialize or loosen the sandbox. A one-off approval does not create a permanent exception.

Sandbox lifecycle:

```text
session_start
  → load and validate frozen config
  → initialize SandboxManager
  → register active execution adapters

session_shutdown
  → idempotent SandboxManager.reset()
```

If required sandbox initialization fails, mutation and execution tools enter a read-only degraded state. The extension must not fall back to unsandboxed Bash.

## 10. Configuration

Configuration sources, from base to overlay:

1. Built-in safety baseline.
2. `~/.pi/agent/permissions.json`.
3. `<project>/.pi/permissions.json`, loaded only after Pi trusts the project.

Example:

```json
{
  "version": 1,
  "defaultMode": "default",
  "reviewer": {
    "provider": "openai",
    "model": "gpt-5.4-mini",
    "reasoningEffort": "low",
    "timeoutMs": 30000,
    "maxConsecutiveDenials": 3
  },
  "sandbox": {
    "enabled": true,
    "profile": "workspace-write",
    "filesystem": {
      "allowWrite": [".", "/tmp"],
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
      "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
    },
    "network": {
      "allowedDomains": [
        "github.com",
        "*.github.com",
        "registry.npmjs.org"
      ]
    }
  },
  "rules": []
}
```

Configuration rules:

- built-in hard protections cannot be removed;
- global deny rules remain effective under project configuration;
- project configuration may tighten restrictions directly;
- project configuration that expands writes or network access requires explicit user confirmation;
- effective configuration is frozen for the session;
- active permission configuration and loaded package source are protected from agent-initiated writes;
- users may edit configuration outside the agent flow and then explicitly reload it;
- `/reload` or a new session is required to apply changes.

## 11. Session State

State is persisted through Pi session entries:

```ts
interface PermissionSessionState {
  mode: "default" | "plan" | "auto";
  pendingMode?: "default" | "plan" | "auto";
  modeBeforePlan?: "default" | "auto";
  plan?: {
    markdown: string;
    status: "draft" | "approved" | "revising";
  };
  auto: {
    consecutiveDenials: number;
    paused: boolean;
  };
  sandboxProfile: string;
  configFingerprint: string;
}
```

The extension reconstructs state on `session_start` and `session_tree`. New sessions use `defaultMode`; resumed sessions use their last recorded mode and sandbox profile. A changed configuration fingerprint is resolved to the stricter effective boundary and reported to the user.

## 12. Failure Behavior

Security failures are fail-closed:

| Failure | Result |
|---|---|
| Invalid configuration | Read-only degraded mode with exact file error |
| Sandbox initialization failure | No mutation or command execution |
| Reviewer model missing or unauthenticated | Auto unavailable |
| Reviewer timeout or malformed response | Deny current request |
| Three consecutive reviewer denials | Pause Auto and escalate |
| User interaction required without UI | Deny |
| Approval pending during reload | Cancel and deny request |
| Audit write failure | Preserve decision, display warning |
| Shortcut conflict | Commands remain available and warning explains remap |

No component failure may restore the original unsandboxed YOLO behavior.

## 13. UI

Compact status examples:

```text
◆ default · sandbox
◇ plan · read-only
◆ auto · reviewer:<model> · sandbox
→ auto
⚠ auto paused
⚠ sandbox degraded
```

`/permissions` reports:

- active and pending mode;
- effective sandbox profile and writable roots;
- reviewer model and availability;
- rule source and matched precedence;
- current degradation or pause reason.

Audit entries include request metadata, risk, matched rule, mode, reviewer decision, final decision, reason, and timestamp. They exclude file bodies, secrets, full environment variables, and raw credentials.

## 14. Testing

Unit tests cover:

- configuration validation and merge precedence;
- rule severity;
- path canonicalization and symlink boundaries;
- Bash chains, pipelines, redirection, and nested execution;
- risk classification;
- reviewer parsing and failure paths;
- mode state transitions and pending transitions;
- session reconstruction.

Integration tests cover:

- Default approval behavior;
- Plan write and command blocking;
- Plan approval into Default or Auto;
- Auto reviewer invocation;
- hard-operation escalation;
- direct WebSearch and SSRF-safe WebFetch handling;
- non-interactive denial;
- reload without duplicate registration.

Reviewer tests use a fake model and cover approve, deny, escalate, timeout, malformed output, empty output, API error, and the three-denial fallback.

Sandbox end-to-end tests cover:

- allowed workspace writes;
- denied outside-workspace writes;
- configured `/tmp` writes;
- protected credential paths;
- child-process inheritance;
- failed initialization degradation;
- idempotent shutdown;
- one-off approvals that do not persist.

Shortcut tests cover:

- reserved `Shift+Tab` detection;
- successful registration after remapping `app.thinking.cycle`;
- `Default → Plan → Auto → Default`;
- rapid repeated input without races;
- slash-command fallback.

## 15. Delivery Stages

1. Package scaffold, type checking, tests, and configuration schema.
2. Default and Plan state machine, persistence, Plan gate, and approval UI.
3. Request normalization, rules, static risk classifier, and protected paths.
4. OS sandbox, Bash wrapping, filesystem guards, network policy, and environment filtering.
5. Independent reviewer, Auto mode, denial retry, and escalation.
6. Shift+Tab cycle, status UI, commands, and shortcut-conflict guidance.
7. Security regression tests, hot reload, resume behavior, documentation, and local installation.

Auto must not be exposed before the permission engine and sandbox are operational.

## 16. Completion Criteria

The work is complete only when:

- `npm test` passes;
- `npm run check` passes;
- Default is no longer YOLO;
- Plan cannot modify source or run side-effecting commands;
- Auto uses the independently configured reviewer for `REVIEW` operations;
- reviewer failure never approves a request;
- sandbox failure never falls back to unprotected execution;
- writes outside the workspace fail by default;
- sensitive paths are denied by default;
- Shift+Tab cycles Default, Plan, and Auto after the Pi thinking shortcut is remapped;
- slash commands and non-interactive configuration remain usable;
- session resume and `/reload` preserve consistent state;
- audit records contain no secrets or file bodies;
- the package is verified against the installed Pi 0.82.1 runtime.
