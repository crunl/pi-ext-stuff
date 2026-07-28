# pi-permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and locally install a Pi package that provides Default, Plan, and independently reviewed Auto modes with fail-closed permission policy and OS-level sandboxing.

**Architecture:** A single Pi extension routes every tool call through normalized request, hard protection, explicit rules, static risk, mode policy, reviewer/user resolution, and sandbox execution. Session mode and audit metadata persist through Pi session entries; the sandbox is initialized once per session and never silently disabled.

**Tech Stack:** TypeScript 5, Pi 0.82.1 extension APIs, `@earendil-works/pi-ai`, TypeBox, Vitest 4, and `@anthropic-ai/sandbox-runtime` 0.0.26.

## Global Constraints

- Package name is exactly `pi-permissions`.
- User modes are exactly `default`, `plan`, and `auto`.
- Primary cycle is `Default → Plan → Auto → Default`.
- Auto uses an independently configured reviewer and never silently inherits the main model.
- Hard protection and explicit deny rules cannot be overridden by Auto or project configuration.
- `WebSearch` and public SSRF-safe `WebFetch` are low risk; their returned content remains untrusted.
- Sandbox or reviewer failure must fail closed.
- Writes are limited to the workspace and `/tmp` by default.
- Default protected paths include `~/.ssh`, `~/.aws`, `~/.gnupg`, `.env`, `.env.*`, `*.pem`, and `*.key`.
- Runtime dependency `@anthropic-ai/sandbox-runtime` is pinned to `0.0.26`.
- Pi-provided packages remain peer dependencies with `"*"` ranges.
- TypeScript is loaded directly by Pi; do not add a `dist/` build.
- Target and verify the installed Pi version `0.82.1`.
- Use test-driven development: add one focused failing test, observe the expected failure, add the minimum implementation, then rerun it.

---

## File Map

- `index.ts`: Pi package entry; delegates to `src/register.ts`.
- `src/register.ts`: composes configuration, state, policy, reviewer, sandbox, commands, tools, events, and status UI.
- `src/config.ts`: configuration types, defaults, validation, source loading, merge rules, and fingerprint.
- `src/state.ts`: mode state, pending transitions, session-entry persistence, and branch reconstruction.
- `src/modes/controller.ts`: idle-safe Default/Plan/Auto transitions.
- `src/modes/plan.ts`: Plan tool gate, planning prompt, and plan approval outcomes.
- `src/modes/auto.ts`: Auto denial count, pause, resume, and escalation.
- `src/permissions/paths.ts`: canonical path resolution, workspace checks, and protected paths.
- `src/permissions/rules.ts`: rule parsing, matching, and `deny > ask > allow`.
- `src/permissions/risk.ts`: request normalization and static LOW/REVIEW/HARD classification.
- `src/permissions/engine.ts`: single authorization decision pipeline.
- `src/reviewer/schema.ts`: strict reviewer decision parser.
- `src/reviewer/prompt.ts`: bounded, injection-resistant reviewer prompt.
- `src/reviewer/client.ts`: model lookup, authentication, independent completion, timeout, and fail-closed result.
- `src/sandbox/bash.ts`: sandboxed Bash operations.
- `src/sandbox/network.ts`: host/domain/IP validation and environment filtering.
- `src/sandbox/manager.ts`: `SandboxManager` lifecycle and degraded state.
- `src/ui/commands.ts`: `/default`, `/plan`, `/auto`, `/permissions`, and `/sandbox`.
- `src/ui/status.ts`: compact active/pending/degraded status.
- `src/ui/prompts.ts`: plan approval and user approval dialogs.
- `tests/*.test.ts`: unit and integration coverage.

---

### Task 1: Package Scaffold and Configuration Contract

**Files:**
- Create: `index.ts`
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `src/register.ts`
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

**Interfaces:**
- Produces: `PermissionsConfig`, `LoadedPermissionsConfig`, `DEFAULT_CONFIG`, `validatePermissionsConfig(input)`, `loadPermissionsConfig(cwd, agentDir, projectTrusted)`, `mergePermissionsConfig(base, overlay)`, and `fingerprintConfig(config)`.
- Consumes: Node filesystem/path APIs only.

- [ ] **Step 1: Add the package manifest and test toolchain**

Use this manifest:

```json
{
  "name": "pi-permissions",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] },
  "scripts": {
    "check": "tsc --noEmit",
    "test": "vitest --run"
  },
  "dependencies": {
    "@anthropic-ai/sandbox-runtime": "0.0.26"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-ai": "0.82.1",
    "@earendil-works/pi-coding-agent": "0.82.1",
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "typebox": "1.1.38",
    "vitest": "^4.1.0"
  }
}
```

Use `moduleResolution: "Bundler"`, `allowImportingTsExtensions: true`, `strict: true`, `noEmit: true`, and include `index.ts`, `src/**/*.ts`, and `tests/**/*.ts` in `tsconfig.json`.

- [ ] **Step 2: Install dependencies and generate the lockfile**

Run:

```bash
npm install
```

Expected: exit 0 and `package-lock.json` pins sandbox-runtime 0.0.26.

- [ ] **Step 3: Write failing configuration tests**

Cover defaults, project tightening, global-deny precedence, invalid JSON, and stable fingerprints:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  fingerprintConfig,
  mergePermissionsConfig,
  validatePermissionsConfig,
} from "../src/config.ts";

describe("permissions config", () => {
  it("defaults to sandboxed default mode", () => {
    expect(DEFAULT_CONFIG.defaultMode).toBe("default");
    expect(DEFAULT_CONFIG.sandbox.enabled).toBe(true);
    expect(DEFAULT_CONFIG.sandbox.filesystem.allowWrite).toEqual([".", "/tmp"]);
  });

  it("does not let a project allow override a global deny", () => {
    const merged = mergePermissionsConfig(
      { ...DEFAULT_CONFIG, rules: [{ action: "deny", tool: "bash", pattern: "git push*" }] },
      { rules: [{ action: "allow", tool: "bash", pattern: "git push origin feature" }] },
    );
    expect(merged.rules[0]?.action).toBe("deny");
  });

  it("rejects an unknown mode", () => {
    expect(() => validatePermissionsConfig({ version: 1, defaultMode: "yolo" })).toThrow(/defaultMode/);
  });

  it("produces stable fingerprints", () => {
    expect(fingerprintConfig(DEFAULT_CONFIG)).toBe(fingerprintConfig(structuredClone(DEFAULT_CONFIG)));
  });
});
```

- [ ] **Step 4: Run the configuration test and observe failure**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 5: Implement configuration types, validation, merge, and loading**

Define the exact root:

```ts
export interface PermissionsConfig {
  version: 1;
  defaultMode: "default" | "plan" | "auto";
  reviewer?: {
    provider: string;
    model: string;
    reasoningEffort: "minimal" | "low" | "medium" | "high";
    timeoutMs: number;
    maxConsecutiveDenials: number;
  };
  sandbox: {
    enabled: boolean;
    profile: "workspace-write" | "read-only";
    filesystem: {
      allowWrite: string[];
      denyRead: string[];
      denyWrite: string[];
    };
    network: { allowedDomains: string[]; deniedDomains: string[] };
  };
  rules: Array<{ action: "allow" | "ask" | "deny"; tool: string; pattern?: string }>;
}
```

Load `~/.pi/agent/permissions.json` first and `<cwd>/.pi/permissions.json` second only when `projectTrusted` is true. Invalid JSON throws a `ConfigError` containing the exact path. Preserve global denies before all project rules, intersect project network allowlists with a non-empty global allowlist, and never permit project configuration to set `sandbox.enabled` from `true` to `false`.

Return both the effective config and requested project expansions:

```ts
export interface LoadedPermissionsConfig {
  config: PermissionsConfig;
  globalConfig: PermissionsConfig;
  projectExpansions: Array<
    | { kind: "write-root"; value: string }
    | { kind: "network-domain"; value: string }
  >;
}
```

Do not apply project expansions until the integration layer obtains explicit user confirmation. Project restrictions and deny rules apply without confirmation.

- [ ] **Step 6: Add the minimal Pi entry**

```ts
// index.ts
export { registerExtension as default } from "./src/register.ts";

// src/register.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerExtension(_pi: ExtensionAPI): void {}
```

- [ ] **Step 7: Verify and commit**

Run:

```bash
npm test -- tests/config.test.ts
npm run check
```

Expected: both exit 0.

Commit:

```bash
git add index.ts package.json package-lock.json tsconfig.json .gitignore LICENSE src/register.ts src/config.ts tests/config.test.ts
git commit -m "feat: scaffold pi-permissions configuration"
```

---

### Task 2: Persistent Mode State Machine

**Files:**
- Create: `src/state.ts`
- Create: `src/modes/controller.ts`
- Create: `src/modes/auto.ts`
- Create: `tests/modes.test.ts`

**Interfaces:**
- Produces: `PermissionMode`, `PermissionSessionState`, `ModeController`, `reducePermissionEntries(entries, defaults)`, and `AutoState`.
- Consumes: `PermissionsConfig.defaultMode`, `sandbox.profile`, and `fingerprintConfig`.

- [ ] **Step 1: Write failing mode transition tests**

```ts
import { describe, expect, it } from "vitest";
import { ModeController } from "../src/modes/controller.ts";

describe("ModeController", () => {
  it("cycles default to plan to auto to default", () => {
    const controller = new ModeController("default");
    expect(controller.cycle({ idle: true })).toBe("plan");
    expect(controller.cycle({ idle: true })).toBe("auto");
    expect(controller.cycle({ idle: true })).toBe("default");
  });

  it("queues a transition while busy", () => {
    const controller = new ModeController("default");
    expect(controller.request("plan", { idle: false, approvalActive: false })).toEqual({
      active: "default",
      pending: "plan",
    });
    expect(controller.flushPending()).toBe("plan");
  });

  it("does not change mode during approval", () => {
    const controller = new ModeController("auto");
    expect(() => controller.request("default", { idle: true, approvalActive: true })).toThrow(/approval/);
  });
});
```

- [ ] **Step 2: Run the mode test and observe failure**

Run `npm test -- tests/modes.test.ts`.

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement state and controller**

Use:

```ts
export type PermissionMode = "default" | "plan" | "auto";

export interface PermissionSessionState {
  mode: PermissionMode;
  pendingMode?: PermissionMode;
  modeBeforePlan?: Exclude<PermissionMode, "plan">;
  plan?: { markdown: string; status: "draft" | "approved" | "revising" };
  auto: { consecutiveDenials: number; paused: boolean };
  sandboxProfile: "workspace-write" | "read-only";
  configFingerprint: string;
}
```

`ModeController.request()` applies immediately only when idle and no approval is active. `cycle()` uses the exact order `default`, `plan`, `auto`. `flushPending()` applies one queued transition and clears it.

State persistence uses `pi.appendEntry("pi-permissions-state", state)`. Reconstruction scans the active branch in order and returns the last valid state entry; malformed entries are ignored and reported by the caller.

- [ ] **Step 4: Implement Auto denial state**

```ts
export function recordAutoDecision(
  state: AutoState,
  decision: "approve" | "deny" | "escalate",
  limit: number,
): AutoState {
  if (decision === "approve") return { consecutiveDenials: 0, paused: false };
  if (decision === "escalate") return { ...state, paused: true };
  const consecutiveDenials = state.consecutiveDenials + 1;
  return { consecutiveDenials, paused: consecutiveDenials >= limit };
}
```

Add tests for reset after approval and pause on the third denial.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- tests/modes.test.ts
npm run check
```

Commit:

```bash
git add src/state.ts src/modes/controller.ts src/modes/auto.ts tests/modes.test.ts
git commit -m "feat: add persistent permission mode state"
```

---

### Task 3: Request Normalization, Paths, Rules, and Risk

> **Contract note (user-authorized architecture contraction):** Task 3 is a narrow static classifier, not a Bash parser. It grants `LOW` only to bare, syntax-free commands from a fixed read-only allowlist with safe arguments. Quotes, escapes, substitutions, redirects, control operators, pipelines, newlines, backgrounding, nested shells, deletes, pushes, network commands, publish/deploy markers, and other complex Bash are `HARD`; unknown simple commands are `REVIEW`. Task 5 owns controlled-PATH/realpath executable identity, filesystem, sensitive-read, write-root, and runtime network enforcement.

**Files:**
- Create: `src/permissions/paths.ts`
- Create: `src/permissions/rules.ts`
- Create: `src/permissions/risk.ts`
- Create: `tests/permissions.test.ts`

**Interfaces:**
- Produces: `PermissionRule`, `PermissionRequest`, `normalizeToolCall(tool, input, cwd)`, `matchRules(request, rules)`, `classifyRisk(request)`, and `isPathAllowed(path, policy)`.
- Consumes: `PermissionsConfig.rules` and sandbox filesystem policy.

- [ ] **Step 1: Write failing path and rule tests**

Include these cases:

```ts
it("rejects writes outside the workspace", async () => {
  const result = await isPathAllowed("/Users/example/.ssh/config", {
    cwd: "/work/repo",
    allowWrite: [".", "/tmp"],
    denyRead: ["~/.ssh"],
    denyWrite: [".env", "*.pem"],
    operation: "write",
  });
  expect(result.allowed).toBe(false);
});

it("gives deny precedence over a narrower allow", () => {
  const match = matchRules(request("bash", "git push origin main"), [
    { action: "allow", tool: "bash", pattern: "git push origin main" },
    { action: "deny", tool: "bash", pattern: "git push*" },
  ]);
  expect(match?.action).toBe("deny");
});

it("does not classify a chained destructive command as read-only", () => {
  const req = normalizeToolCall("bash", { command: "git status && rm -rf build" }, "/work/repo");
  expect(classifyRisk(req)).toBe("REVIEW");
});
```

Also cover pipelines, redirects, `bash -c`, command substitution, `git push --force`, `npm publish`, localhost, private IPs, cloud metadata, `WebSearch`, and `WebFetch`.

- [ ] **Step 2: Run the permission test and observe failure**

Run `npm test -- tests/permissions.test.ts`.

Expected: FAIL because permission modules do not exist.

- [ ] **Step 3: Implement canonical path policy**

Resolve relative paths against `cwd`, expand `~`, call `realpath()` for existing ancestors, and compare path components instead of string prefixes. Reject a symlink whose canonical target escapes an allowed write root. Match protected file globs against the workspace-relative path and basename. Treat the resolved package root, `~/.pi/agent/permissions.json`, and `<cwd>/.pi/permissions.json` as protected control paths.

Return:

```ts
type PathDecision =
  | { allowed: true; canonicalPath: string }
  | { allowed: false; canonicalPath: string; reason: string };
```

- [ ] **Step 4: Implement narrow command normalization**

Represent each Bash segment:

```ts
interface CommandSegment {
  source: string;
  executable: string;
  args: string[];
  hasRedirect: boolean;
  hasSubstitution: boolean;
  nestedShell: boolean;
}
```

Only the fixed read-only allowlist (`ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `rg`, and `grep`) can become LOW, and only when the command is a bare token with no shell syntax and safe arguments. `rg` requires first-position `--no-config`. Any quote, escape, variable, substitution, redirect, control operator, pipeline, newline, backgrounding, nested shell, delete, push, network executable, publish/deploy marker, or unsafe argument is `HARD`; unknown simple commands are `REVIEW`.

- [ ] **Step 5: Implement rules and risk**

Rules use case-sensitive tool names and simple glob matching for patterns. Evaluate all matches, choose `deny` before `ask` before `allow`, and include the matched rule in the result.

```ts
export interface PermissionRule {
  action: "allow" | "ask" | "deny";
  tool: string;
  pattern?: string;
}
```

Classify:

- LOW: reads, searches, allowed workspace edits, `WebSearch`, public `WebFetch`, and the read-only command allowlist.
- REVIEW: simple unknown commands, installs, external writes, and MCP tools with side effects.
- HARD: complex Bash syntax, deletes, `git push`, shell network executables, publish/deploy/production-destroy markers, private WebFetch targets, and protected configuration writes.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npm test -- tests/permissions.test.ts
npm run check
```

Commit:

```bash
git add src/permissions/paths.ts src/permissions/rules.ts src/permissions/risk.ts tests/permissions.test.ts
git commit -m "feat: classify permission requests"
```

---

### Task 4: Plan Mode Gate and Approval Flow

**Files:**
- Create: `src/modes/plan.ts`
- Create: `src/ui/prompts.ts`
- Create: `tests/plan.test.ts`
- Modify: `src/register.ts`

**Interfaces:**
- Produces: `isAllowedInPlan(request)`, `registerPlanTool(pi, dependencies)`, and `showPlanApproval(ctx, markdown)`.
- Consumes: `ModeController`, `normalizeToolCall`, and state persistence callback.

- [ ] **Step 1: Write failing Plan gate tests**

```ts
it.each(["edit", "write"])("blocks %s in plan", (tool) => {
  expect(isAllowedInPlan(normalizeToolCall(tool, { path: "src/a.ts" }, cwd))).toEqual({
    allowed: false,
    reason: expect.stringContaining("Plan mode"),
  });
});

it("blocks Bash redirection in plan", () => {
  const request = normalizeToolCall("bash", { command: "printf x > src/a.ts" }, cwd);
  expect(isAllowedInPlan(request).allowed).toBe(false);
});

it("allows WebSearch in plan", () => {
  expect(isAllowedInPlan(normalizeToolCall("WebSearch", { query: "Pi API" }, cwd)).allowed).toBe(true);
});
```

- [ ] **Step 2: Run the Plan test and observe failure**

Run `npm test -- tests/plan.test.ts`.

- [ ] **Step 3: Implement Plan gate and planning prompt**

`isAllowedInPlan()` permits only read operations, safe read-only Bash, `WebSearch`, public `WebFetch`, and `exit_plan_mode`.

Append Plan instructions during `before_agent_start` only while Plan is active by returning `{ systemPrompt: event.systemPrompt + instructions }`:

```text
You are in Plan mode. Inspect and ask questions, but do not modify source or run side-effecting commands. When the plan is ready, call exit_plan_mode with concise Markdown containing context, ordered implementation steps, critical files, and verification.
```

- [ ] **Step 4: Register `exit_plan_mode` with TypeBox**

```ts
const ExitPlanParams = Type.Object({
  plan: Type.String({ minLength: 1, description: "Implementation plan in Markdown" }),
});
```

The tool displays `Execute in Auto`, `Execute in Default`, and `Keep Planning`. It updates state only after the user selects. Pass reviewer/sandbox availability into the dialog; when Auto is unavailable, show its reason and do not permit that selection. With no UI, return an error result and remain in Plan.

When entering Plan, save the exact active tool list and remove `edit` and `write` from `pi.setActiveTools()`. Preserve all other built-in and extension tools. Restore the saved list only after an approved exit or explicit return to Default/Auto. Keep the Plan gate hook as defense in depth for Bash and stale tool calls.

- [ ] **Step 5: Add mocked UI integration tests**

Verify each selection changes state correctly and that Keep Planning stores status `revising`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npm test -- tests/plan.test.ts tests/modes.test.ts
npm run check
```

Commit:

```bash
git add src/modes/plan.ts src/ui/prompts.ts src/register.ts tests/plan.test.ts
git commit -m "feat: add gated plan mode"
```

---

### Task 5: OS Sandbox and Bash Execution Boundary

> **Runtime boundary requirement:** Task 5 must execute Bash with a controlled PATH and realpath/revalidate the selected bare executable immediately before execution. It must enforce sensitive read denial, canonical write roots and deny rules, and network target policy at runtime. Static Task 3 classification is not a substitute for any of these checks.

**Files:**
- Create: `src/sandbox/network.ts`
- Create: `src/sandbox/bash.ts`
- Create: `src/sandbox/manager.ts`
- Create: `tests/sandbox.test.ts`
- Modify: `src/register.ts`

**Interfaces:**
- Produces: `PermissionsSandbox`, `createSandboxedBashOperations()`, `filterShellEnvironment(env)`, and `validateNetworkTarget(target)`.
- Consumes: effective sandbox configuration and Pi `createBashTool`.

- [ ] **Step 1: Write failing sandbox unit tests**

Test environment filtering and network targets:

```ts
it("removes credential variables from child environments", () => {
  expect(filterShellEnvironment({
    PATH: "/usr/bin",
    OPENAI_API_KEY: "secret",
    BRAVE_API_KEY: "secret",
    LANG: "en_US.UTF-8",
  })).toEqual({ PATH: "/usr/bin", LANG: "en_US.UTF-8" });
});

it.each(["http://127.0.0.1", "http://169.254.169.254", "http://10.0.0.1"])(
  "denies private target %s",
  async (url) => expect((await validateNetworkTarget(url)).allowed).toBe(false),
);
```

- [ ] **Step 2: Run the sandbox test and observe failure**

Run `npm test -- tests/sandbox.test.ts`.

- [ ] **Step 3: Implement sandbox lifecycle**

`PermissionsSandbox.initialize(config, cwd)` calls:

```ts
await SandboxManager.initialize({
  network: {
    allowedDomains: config.network.allowedDomains,
    deniedDomains: config.network.deniedDomains,
  },
  filesystem: {
    denyRead: config.filesystem.denyRead,
    allowWrite: config.filesystem.allowWrite,
    denyWrite: config.filesystem.denyWrite,
  },
});
```

Track `uninitialized`, `active`, `degraded`, and `stopped`. Initialization errors set `degraded` and retain the error message. `reset()` is idempotent.

- [ ] **Step 4: Implement sandboxed Bash operations**

Wrap each authorized command with `SandboxManager.wrapWithSandbox(command)`, spawn it with the filtered environment, stream stdout/stderr, honor timeout and AbortSignal, and kill the process group on abort or timeout. Do not run the original command when sandbox state is degraded.

- [ ] **Step 5: Override Pi Bash and user Bash**

Register a `bash` tool based on `createBashTool(cwd)` and use sandboxed operations only after permission authorization. Intercept `user_bash` with the same operations. Register session initialization and idempotent shutdown handlers.

- [ ] **Step 6: Add macOS end-to-end checks**

Create temporary workspace and outside directories. Verify:

- workspace file creation exits 0;
- outside file creation is denied;
- configured `/tmp` creation succeeds;
- protected credential read fails;
- sandbox initialization failure returns a degraded error instead of running locally.

Use `mkdtemp()` and remove only the exact test-created directories during cleanup.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npm test -- tests/sandbox.test.ts
npm run check
```

Commit:

```bash
git add src/sandbox/network.ts src/sandbox/bash.ts src/sandbox/manager.ts src/register.ts tests/sandbox.test.ts
git commit -m "feat: enforce sandboxed command execution"
```

---

### Task 6: Independent Reviewer and Auto Decisions

**Files:**
- Create: `src/reviewer/schema.ts`
- Create: `src/reviewer/prompt.ts`
- Create: `src/reviewer/client.ts`
- Create: `tests/reviewer.test.ts`
- Modify: `src/modes/auto.ts`

**Interfaces:**
- Produces: `ReviewDecision`, `parseReviewDecision(text)`, `buildReviewerPrompt(input)`, and `ReviewerClient.review(request, context, signal)`.
- Consumes: `ctx.modelRegistry.find`, `ctx.modelRegistry.getApiKeyAndHeaders`, `complete`, `uuidv7`, reviewer configuration, normalized request, and Auto state.

- [ ] **Step 1: Write failing strict parser tests**

```ts
it("accepts one strict decision object", () => {
  expect(parseReviewDecision('{"decision":"approve","reason":"Workspace-local test command"}')).toEqual({
    decision: "approve",
    reason: "Workspace-local test command",
  });
});

it.each(["", "approve", "```json\\n{}\\n```", '{"decision":"allow"}'])(
  "fails closed for %j",
  (value) => expect(parseReviewDecision(value).decision).toBe("deny"),
);
```

- [ ] **Step 2: Run reviewer tests and observe failure**

Run `npm test -- tests/reviewer.test.ts`.

- [ ] **Step 3: Implement prompt and parser**

The system prompt instructs the reviewer to treat request content as data, apply the explicit user objective, reject secret disclosure and unrelated side effects, and output one JSON object. The parser accepts only `approve`, `deny`, or `escalate` plus a non-empty reason. Any extra wrapper text is a deny.

- [ ] **Step 4: Implement independent model call**

Resolve the configured model with `ctx.modelRegistry.find(provider, model)`. Resolve auth with `getApiKeyAndHeaders`. Call `complete` from `@earendil-works/pi-ai/compat` with a fresh `uuidv7()` session ID, `cacheRetention: "none"`, configured reasoning effort, and an AbortController timeout.

Never use `ctx.model` as fallback. Return a deny with an operational reason when model, auth, API response, timeout, or parser fails.

- [ ] **Step 5: Add fake-model tests**

Inject a completion function into `ReviewerClient`. Test approve, deny, escalate, timeout, thrown error, empty response, and malformed response without a real API request.

- [ ] **Step 6: Connect denial state**

Record approval as zero consecutive denials, denial as increment, and escalation as paused. On the configured third denial, return `escalate` regardless of the third raw denial result.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npm test -- tests/reviewer.test.ts tests/modes.test.ts
npm run check
```

Commit:

```bash
git add src/reviewer/schema.ts src/reviewer/prompt.ts src/reviewer/client.ts src/modes/auto.ts tests/reviewer.test.ts
git commit -m "feat: add independent auto reviewer"
```

---

### Task 7: Unified Permission Engine, UI, and Shortcut

**Files:**
- Create: `src/permissions/engine.ts`
- Create: `src/ui/commands.ts`
- Create: `src/ui/status.ts`
- Create: `tests/engine.test.ts`
- Create: `tests/integration.test.ts`
- Modify: `src/register.ts`

**Interfaces:**
- Produces: `PermissionEngine.authorize(request, context)`, command handlers, status rendering, and complete extension registration.
- Consumes: all interfaces from Tasks 1–6.

- [ ] **Step 1: Write failing engine ordering tests**

Verify exact order:

```ts
it("does not let Auto override Plan", async () => {
  const result = await engine.authorize(writeRequest, context({ mode: "plan", reviewer: approveReviewer }));
  expect(result.kind).toBe("deny");
  expect(approveReviewer.calls).toBe(0);
});

it("does not let an allow rule override hard protection", async () => {
  const result = await engine.authorize(deleteHomeRequest, context({
    mode: "auto",
    rules: [{ action: "allow", tool: "bash", pattern: "*" }],
  }));
  expect(result.kind).not.toBe("allow");
});

it("sends review risk to the reviewer only in Auto", async () => {
  expect((await engine.authorize(pushRequest, context({ mode: "auto" }))).toMatchObject({
    kind: "allow",
    source: "reviewer",
  });
});
```

- [ ] **Step 2: Run engine tests and observe failure**

Run `npm test -- tests/engine.test.ts`.

- [ ] **Step 3: Implement the authorization pipeline**

Use:

```ts
type AuthorizationResult =
  | { kind: "allow"; source: "low-risk" | "rule" | "reviewer" | "user"; reason: string }
  | { kind: "deny"; source: "plan" | "hard" | "rule" | "reviewer" | "system"; reason: string }
  | { kind: "ask-user"; reason: string };
```

Define `AuthorizationContext` with exact callbacks:

```ts
interface AuthorizationContext {
  mode: PermissionMode;
  rules: PermissionRule[];
  askUser(request: PermissionRequest, reason: string): Promise<boolean>;
  review(request: PermissionRequest, reason: string): Promise<ReviewDecision>;
}
```

Execute Plan gate, hard protection, matching deny, matching ask/allow, risk classification, mode policy, and reviewer/user resolution in the documented order. The tool hook returns `{ block: true, reason }` for deny and unresolved user decisions.

- [ ] **Step 4: Implement user-facing commands**

Register:

- `/default`: request Default.
- `/plan`: request Plan and accept inline planning text.
- `/auto`: validate sandbox and reviewer, then request Auto.
- `/permissions`: display mode, reviewer, sandbox, writable roots, and degradation.
- `/sandbox`: display the effective sandbox policy.

In non-interactive contexts, commands that require selection return an explicit error without changing mode.

When `/auto` is requested without a valid reviewer:

1. Read authenticated candidates from `ctx.modelRegistry.getAvailable()`.
2. Ask the user to select one.
3. Confirm the exact provider/model before writing.
4. Patch only the `reviewer` object in `~/.pi/agent/permissions.json`.
5. Call `ctx.reload()` and enable Auto only after the reloaded extension validates the reviewer.

When no authenticated candidates exist, remain in the current mode and display the authentication requirement.

- [ ] **Step 5: Implement status and Shift+Tab**

Read `~/.pi/agent/keybindings.json` during startup. If `app.thinking.cycle` still includes `shift+tab`, display one warning and rely on commands. Otherwise register:

```ts
pi.registerShortcut("shift+tab", {
  description: "Cycle Default, Plan, and Auto modes",
  handler: async (ctx) => requestModeCycle(ctx),
});
```

`requestModeCycle(ctx)` computes the next mode, validates Auto availability before entering it, queues the transition when `ctx.isIdle()` is false, persists the resulting state, and refreshes status. Render active, pending, paused, and degraded states with the compact labels defined in the design.

- [ ] **Step 6: Complete extension registration**

At session start:

1. Load and validate frozen configuration.
2. If configuration is invalid, enter read-only degraded state and expose the exact error.
3. Ask the user about each project expansion; apply only approved expansions.
4. Initialize state from the active session branch.
5. Initialize sandbox.
6. Resolve reviewer availability.
7. Set status.

Register one `tool_call` hook that normalizes and authorizes calls. Append redacted audit entries after meaningful decisions. Register `turn_end` to flush a pending mode, `session_tree` to reconstruct branch state, and `session_shutdown` to reset sandbox resources.

- [ ] **Step 7: Add integration tests**

Use fake Pi APIs and UI to verify Default asks, Plan blocks, Auto reviews, hard operations escalate, audit data excludes tool content and environment values, reload registration is idempotent, and pending modes apply after a turn.

- [ ] **Step 8: Verify and commit**

Run:

```bash
npm test -- tests/engine.test.ts tests/integration.test.ts
npm test
npm run check
```

Commit:

```bash
git add src/permissions/engine.ts src/ui/commands.ts src/ui/status.ts src/register.ts tests/engine.test.ts tests/integration.test.ts
git commit -m "feat: integrate permission modes and approvals"
```

---

### Task 8: Documentation, Local Installation, and Acceptance Verification

**Files:**
- Create: `README.md`
- Create: `permissions.example.json`
- Modify: `.gitignore`
- Modify: `package.json`
- Test: all `tests/*.test.ts`

**Interfaces:**
- Produces: installable local package and operator documentation.
- Consumes: completed extension behavior from Tasks 1–7.

- [ ] **Step 1: Write README with exact setup**

Document:

```bash
pi install /Users/x1a2h1/.pi/pi-permissions
```

Document the keybinding change:

```json
{
  "app.thinking.cycle": ["ctrl+shift+."]
}
```

Document `/reload`, all commands, configuration paths, rule precedence, Auto reviewer cost/latency, sandbox degradation, and uninstall:

```bash
pi remove /Users/x1a2h1/.pi/pi-permissions
```

- [ ] **Step 2: Add a redacted example configuration**

Use reviewer placeholders that are clearly examples and are never loaded automatically:

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
      "allowedDomains": ["github.com", "*.github.com", "registry.npmjs.org"],
      "deniedDomains": []
    }
  },
  "rules": []
}
```

- [ ] **Step 3: Run the complete automated suite**

Run:

```bash
npm test
npm run check
```

Expected: all tests pass and type checking exits 0.

- [ ] **Step 4: Install locally and verify Pi discovery**

Run:

```bash
pi install /Users/x1a2h1/.pi/pi-permissions
pi list
```

Expected: `pi-permissions` appears once.

- [ ] **Step 5: Apply the approved Shift+Tab remap**

Merge only `app.thinking.cycle` into `~/.pi/agent/keybindings.json`, preserving every unrelated user keybinding. Run `/reload` in Pi.

Expected: no extension shortcut conflict and the footer changes across Default, Plan, Auto, and Default on four successive states including the starting state.

- [ ] **Step 6: Run manual acceptance scenarios**

In a temporary test repository:

1. Default: edit a workspace file; verify it succeeds.
2. Default: request `git push`; verify user approval appears.
3. Plan: request a source edit and a redirecting Bash command; verify both are blocked.
4. Plan: approve a plan into Auto; verify mode changes only after approval.
5. Auto: run a REVIEW-class fake-safe operation; verify reviewer audit metadata exists.
6. Auto: request a HARD operation; verify it reaches the user or is denied.
7. Sandbox: attempt a write outside workspace; verify failure.
8. Failure: configure an invalid reviewer model; verify Auto is unavailable.
9. Reload: run `/reload`; verify one shortcut and one set of commands remain.

Do not run real pushes, publishes, production commands, or secret reads during acceptance testing.

- [ ] **Step 7: Remove the private guard only if publishing is requested**

Keep `"private": true` for this local implementation. Publication is a separate user-authorized task.

- [ ] **Step 8: Commit documentation and verified install state**

```bash
git add README.md permissions.example.json .gitignore package.json
git commit -m "docs: document pi-permissions setup"
git status --short
```

Expected: clean worktree.
