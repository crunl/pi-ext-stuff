# YOLO Full Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a direct-switching YOLO mode with Codex Full Access semantics and make the plugin-local global `config.json` the only configuration source.

**Architecture:** Extend the existing mode domain with `yolo`, but keep approval ownership orthogonal: Default uses the user, Auto uses Guardian, and YOLO bypasses the permission evaluator entirely. The registered Bash/Write/Edit wrappers choose their backend from the mode at execution time; global configuration is still parsed, while sandbox initialization is skipped for YOLO and prepared transactionally before leaving YOLO.

**Tech Stack:** TypeScript 5.9, Pi extension API 0.82.1, Vitest 4.1, `@anthropic-ai/sandbox-runtime` 0.0.26, Biome.

## Global Constraints

- Work directly in `/Users/x1a2h1/.pi/agent/extensions/pi-permissions`; do not create a worktree.
- Preserve the eight pre-existing modified files and never stage unrelated hunks:
  `src/auto-review-request.ts`, `src/auto-reviewer.ts`, `src/default-mode.ts`,
  `src/permissions/risk.ts`, `tests/auto-review-request.test.ts`,
  `tests/auto-reviewer.test.ts`, `tests/default-mode.test.ts`, and
  `tests/permissions.test.ts`.
- Before editing an already modified file, inspect its current `git diff`; use
  hunk-level staging and verify `git diff --cached` before every commit.
- Do not read `<project>/.pi/permissions.json`; the only configuration source is
  `~/.pi/agent/extensions/pi-permissions/config.json`.
- The executable mode cycle is exactly
  `Default -> Auto -> YOLO -> Default`; no Full Access confirmation is shown.
- YOLO skips policy evaluation, hard blocks, user approval, Guardian, approval
  ledgers, filtering proxy, and sandbox operations.
- YOLO uses Pi-native Bash, Write, and Edit; native Read and other tools pass
  through without extension policy.
- Default and Auto behavior, Guardian policy, and `!bash` behavior must not
  change.
- `defaultMode: "yolo"` must work even when sandbox initialization would fail.
- A transition from YOLO to Default or Auto commits only after the configured
  sandbox is ready, unless global `sandbox.enabled` is `false`.
- Do not change the current global `config.json` value from
  `"defaultMode": "default"`.
- Format and lint all touched TypeScript with strict Biome checks.

## File Structure

- `src/config.ts`: global-only schema, parsing, fingerprinting, and loader.
- `src/state.ts`: persisted permission-mode domain.
- `src/modes/controller.ts`: immediate named transitions and cycle order.
- `src/mode-runtime.ts`: session behavior, Auto state, and compact labels.
- `src/register.ts`: mode commands, authorization routing, backend selection,
  sandbox activation, and status output.
- `src/filesystem-policy.ts`: Default/Auto protected control paths.
- `src/permissions/paths.ts`: canonical filesystem-policy enforcement.
- `src/permissions/risk.ts`: static risk classification for Default/Auto.
- `tests/config.test.ts`: global-only configuration contract.
- `tests/modes.test.ts`, `tests/mode-runtime.test.ts`: mode/state contract.
- `tests/permissions.test.ts`, `tests/default-mode.test.ts`,
  `tests/sandbox.test.ts`: removal of project-config protection.
- `tests/register.test.ts`: end-to-end mode, bypass, backend, lifecycle, and race
  behavior.
- `docs/superpowers/specs/2026-07-30-yolo-full-access-design.md`: approved design.
- `docs/superpowers/plans/2026-07-30-yolo-full-access.md`: this execution plan.

---

### Task 1: Replace layered configuration with one global source

**Files:**
- Modify: `src/config.ts`
- Modify: `src/register.ts`
- Modify: `src/filesystem-policy.ts`
- Modify: `src/permissions/paths.ts`
- Modify with hunk-level staging: `src/permissions/risk.ts`
- Modify: `tests/config.test.ts`
- Modify with hunk-level staging: `tests/permissions.test.ts`
- Modify with hunk-level staging: `tests/default-mode.test.ts`
- Modify: `tests/sandbox.test.ts`

**Interfaces:**
- Consumes: `agentDir`, whose plugin config is
  `extensions/pi-permissions/config.json`.
- Produces:
  `loadPermissionsConfig(agentDir: string): Promise<LoadedPermissionsConfig>`,
  where `LoadedPermissionsConfig` contains only
  `{ config: PermissionsConfig }`.

- [ ] **Step 1: Snapshot the overlapping user changes**

Run:

```bash
git diff -- src/permissions/risk.ts tests/permissions.test.ts tests/default-mode.test.ts
```

Expected: the existing shell-substitution and Git-metadata hardening changes
are visible and remain intact throughout this task.

- [ ] **Step 2: Write failing global-only configuration tests**

Replace the old project-restriction cases in `tests/config.test.ts` with these
contracts:

```ts
it("accepts YOLO as a configured default mode", () => {
  expect(() =>
    validatePermissionsConfig({ version: 1, defaultMode: "yolo" }),
  ).not.toThrow();
});

it("loads only plugin-local global configuration", async () => {
  await withConfigRoots(async ({ agentDir, cwd }) => {
    await writeJson(globalConfigPath(agentDir), {
      defaultMode: "auto",
      sandbox: { network: { allowedDomains: ["github.com"] } },
    });
    await writeJson(join(cwd, ".pi", "permissions.json"), {
      defaultMode: "default",
      sandbox: { network: { allowedDomains: ["attacker.invalid"] } },
    });

    const loaded = await loadPermissionsConfig(agentDir);

    expect(loaded.config.defaultMode).toBe("auto");
    expect(loaded.config.sandbox.network.allowedDomains).toEqual(["github.com"]);
  });
});

it("ignores malformed project permission configuration", async () => {
  await withConfigRoots(async ({ agentDir, cwd }) => {
    await writeJson(globalConfigPath(agentDir), { defaultMode: "default" });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "permissions.json"), "{");

    await expect(loadPermissionsConfig(agentDir)).resolves.toMatchObject({
      config: { defaultMode: "default" },
    });
  });
});
```

Update the invalid-global-JSON and legacy-agent-file tests to call
`loadPermissionsConfig(agentDir)`. Remove imports and tests for
`mergePermissionsConfig`, `globalConfig`, and `projectExpansions`.

- [ ] **Step 3: Write failing tests that make project permissions ordinary**

In `tests/permissions.test.ts`, replace the project-control symlink assertion
with:

```ts
it("treats a project permissions file as an ordinary workspace file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-"));
  temporaryDirectories.push(cwd);
  await mkdir(join(cwd, ".pi"));

  await expect(
    isPathAllowed(".pi/permissions.json", {
      cwd,
      allowWrite: ["."],
      denyRead: [],
      denyWrite: [],
      operation: "write",
    }),
  ).resolves.toMatchObject({ allowed: true });
});
```

In the existing risk test, assert:

```ts
expect(
  classifyRisk(
    normalizeToolCall("edit", { path: ".pi/permissions.json" }, "/work/repo"),
  ),
).toBe("LOW");
```

Keep the global plugin config assertion at `HARD`.

In `tests/default-mode.test.ts`, remove `.pi/permissions.json` from the
repository-control list and add:

```ts
await expect(
  evaluateDefaultRequest(
    "write",
    { path: ".pi/permissions.json", content: "{}" },
    cwd,
    config(),
  ),
).resolves.toMatchObject({ action: "allow", risk: "LOW" });
```

In `tests/sandbox.test.ts`, replace the old containment assertion with:

```ts
expect(runtime.filesystem.denyWrite)
  .not.toContain("/workspace/project/.pi/permissions.json");
```

- [ ] **Step 4: Run the focused tests and verify failure**

Run:

```bash
pnpm exec vitest --run tests/config.test.ts tests/permissions.test.ts tests/default-mode.test.ts tests/sandbox.test.ts
```

Expected: failures show that `yolo` is rejected, the loader still consumes
project configuration, and `.pi/permissions.json` is still protected.

- [ ] **Step 5: Implement the global-only loader**

In `src/config.ts`:

```ts
export interface LoadedPermissionsConfig {
  config: PermissionsConfig;
}

export async function loadPermissionsConfig(
  agentDir: string,
): Promise<LoadedPermissionsConfig> {
  const globalPath = join(
    agentDir,
    "extensions",
    "pi-permissions",
    "config.json",
  );
  const overlay = await readConfigFile(globalPath);
  return {
    config: overlay
      ? mergeGlobalPermissionsConfig(DEFAULT_CONFIG, overlay)
      : cloneConfig(DEFAULT_CONFIG),
  };
}
```

Delete `mergePermissionsConfig`, `projectRestrictions`, `unique`, `intersect`,
the project file read, and expansion calculation. Extend the config mode union,
validation set, and error message with `"yolo"`.

In `src/register.ts`, change every loader call to:

```ts
const candidate = await loadPermissionsConfig(agentDir);
```

Remove `isProjectTrusted` from loader-related context types and remove it from
the cache key:

```ts
const configKey = (ctx: Pick<ExtensionContext, "cwd">): string => ctx.cwd;
```

Keep `cwd` in the key because sandbox paths are materialized per workspace.

- [ ] **Step 6: Remove project-config protection without disturbing hardening**

Remove only `resolve(cwd, ".pi", "permissions.json")` from
`defaultProtectedWritePaths()` in `src/filesystem-policy.ts`.

Remove only the `.pi/permissions.json` default protected control from
`src/permissions/paths.ts`.

In `src/permissions/risk.ts`, change the control-path check to:

```ts
const globalConfig = resolve(
  homedir(),
  ".pi/agent/extensions/pi-permissions/config.json",
);
if (request.resolvedPaths.some((path) => path === globalConfig)) return "HARD";
```

Do not alter the pre-existing shell-substitution parsing or Git-mutation
changes in that file.

- [ ] **Step 7: Run focused tests and type checking**

Run:

```bash
pnpm exec vitest --run tests/config.test.ts tests/permissions.test.ts tests/default-mode.test.ts tests/sandbox.test.ts
pnpm run check
```

Expected: all focused tests and TypeScript checking pass.

- [ ] **Step 8: Commit only Task 1 hunks**

Stage clean files normally and overlapping files interactively:

```bash
git add src/config.ts src/register.ts src/filesystem-policy.ts src/permissions/paths.ts tests/config.test.ts tests/sandbox.test.ts
git add -p src/permissions/risk.ts tests/permissions.test.ts tests/default-mode.test.ts
git diff --cached --check
git diff --cached
git commit -m "refactor: use one global permissions config"
```

Expected staged diff: project-config removal and YOLO schema acceptance only;
none of the pre-existing shell, Git metadata, or unrelated test hunks.

---

### Task 2: Extend the mode domain, commands, and compact status

**Files:**
- Modify: `src/state.ts`
- Modify: `src/modes/controller.ts`
- Modify: `src/mode-runtime.ts`
- Modify: `src/register.ts`
- Modify: `tests/modes.test.ts`
- Modify: `tests/mode-runtime.test.ts`
- Modify: `tests/register.test.ts`

**Interfaces:**
- Consumes: `PermissionsConfig["defaultMode"]`, now including `"yolo"`.
- Produces:
  `PermissionMode = "default" | "plan" | "auto" | "yolo"`,
  `/yolo`, the three-state Shift+Tab cycle, and
  `statusLabel: "Default" | "Auto" | "YOLO"`.

- [ ] **Step 1: Write failing controller and runtime tests**

In `tests/modes.test.ts`:

```ts
it("cycles Default, Auto, and YOLO immediately", () => {
  const controller = new ModeController("default");
  expect(controller.cycle()).toBe("auto");
  expect(controller.cycle()).toBe("yolo");
  expect(controller.cycle()).toBe("default");
});

it("restores a persisted YOLO session state", () => {
  const state = {
    ...createPermissionSessionState(DEFAULT_CONFIG),
    mode: "yolo" as const,
  };
  expect(
    reducePermissionEntries(
      [{ type: "custom", customType: "pi-permissions-state", data: state }],
      DEFAULT_CONFIG,
    ),
  ).toEqual(state);
});
```

In `tests/mode-runtime.test.ts`:

```ts
it("activates and reports YOLO without mutating Auto state", () => {
  const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
  runtime.applyAutoState({ consecutiveDenials: 2, paused: true });

  expect(runtime.activate("yolo")).toBe("yolo");
  expect(runtime.statusLabel).toBe("YOLO");
  expect(runtime.autoState).toEqual({ consecutiveDenials: 2, paused: true });
});
```

- [ ] **Step 2: Write failing registration and status tests**

Update the Shift+Tab test in `tests/register.test.ts`:

```ts
await app.shortcuts.get("shift+tab")!.handler(app.context);
expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "Auto");
await app.shortcuts.get("shift+tab")!.handler(app.context);
expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "YOLO");
await app.shortcuts.get("shift+tab")!.handler(app.context);
expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "Default");
```

Extend the command test:

```ts
expect(app.commands.has("yolo")).toBe(true);
await app.commands.get("yolo")!.handler("", app.context);
expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "YOLO");
```

Add a `/permissions` assertion:

```ts
await app.commands.get("permissions")!.handler("", app.context);
expect(app.notify).toHaveBeenLastCalledWith(
  "YOLO · Full Access · sandbox off · approvals never",
  "info",
);
```

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
pnpm exec vitest --run tests/modes.test.ts tests/mode-runtime.test.ts tests/register.test.ts
```

Expected: failures show the missing mode, command, label, cycle step, and YOLO
status summary.

- [ ] **Step 4: Implement the mode domain**

In `src/state.ts`:

```ts
export type PermissionMode = "default" | "plan" | "auto" | "yolo";

const modes = new Set<PermissionMode>([
  "default",
  "plan",
  "auto",
  "yolo",
]);
```

Allow `modeBeforePlan` to contain `"default"`, `"auto"`, or `"yolo"`.

In `src/modes/controller.ts`:

```ts
const cycleOrder: PermissionMode[] = ["default", "auto", "yolo"];
```

In `src/mode-runtime.ts`:

```ts
get statusLabel(): "Default" | "Auto" | "YOLO" {
  if (this.mode === "default") return "Default";
  if (this.mode === "auto") return "Auto";
  if (this.mode === "yolo") return "YOLO";
  throw new Error("Plan mode is not implemented");
}
```

Keep Auto reset logic conditional on `result === "auto"` only.

- [ ] **Step 5: Implement commands, cycle, and YOLO status**

In `src/register.ts`, import `PermissionMode` and define:

```ts
type ExecutablePermissionMode = Exclude<PermissionMode, "plan">;
```

Change `activateMode` to accept `ExecutablePermissionMode` and register:

```ts
pi.registerCommand("yolo", {
  description: "Activate pi-permissions YOLO Full Access mode",
  handler: async (_args, ctx) => activateMode("yolo", ctx),
});
```

In `/permissions`, branch before reviewer composition:

```ts
if (runtime.mode === "yolo") {
  ctx.ui.notify(
    "YOLO · Full Access · sandbox off · approvals never",
    "info",
  );
  return;
}
```

Do not add a confirmation UI. Continue publishing `YOLO` through the existing
`pi-permissions` status key; the statusline already hides only `Default`.

- [ ] **Step 6: Run focused tests and type checking**

Run:

```bash
pnpm exec vitest --run tests/modes.test.ts tests/mode-runtime.test.ts tests/register.test.ts
pnpm run check
```

Expected: all focused mode and registration tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/state.ts src/modes/controller.ts src/mode-runtime.ts src/register.ts tests/modes.test.ts tests/mode-runtime.test.ts tests/register.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: add YOLO permission mode"
```

---

### Task 3: Bypass approval policy and use native tool backends in YOLO

**Files:**
- Modify: `src/register.ts`
- Modify: `tests/register.test.ts`

**Interfaces:**
- Consumes: `PermissionModeRuntime.mode`.
- Produces: an execution-time full-access decision; no persisted approval grant
  is created for YOLO calls.

- [ ] **Step 1: Write failing interception-bypass tests**

Add to `tests/register.test.ts`:

```ts
it("bypasses hard blocks and every reviewer in YOLO", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  await writeFile(
    globalConfigPath(agentDir),
    JSON.stringify({ defaultMode: "yolo" }),
  );
  const app = harness(agentDir);
  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );

  await expect(
    app.handlers.get("tool_call")!(
      {
        toolName: "WebFetch",
        toolCallId: "yolo-private-network",
        input: { url: "http://127.0.0.1/admin" },
      },
      app.context,
    ),
  ).resolves.toBeUndefined();

  await expect(
    app.handlers.get("tool_call")!(
      {
        toolName: "read",
        toolCallId: "yolo-secret-read",
        input: { path: ".env" },
      },
      app.context,
    ),
  ).resolves.toBeUndefined();

  expect(app.select).not.toHaveBeenCalled();
  expect(app.autoReviewer.review).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write failing native-backend tests**

Add:

```ts
it("uses native Bash without sandbox or network proxy in YOLO", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  await writeFile(
    globalConfigPath(agentDir),
    JSON.stringify({ defaultMode: "yolo" }),
  );
  const app = harness(agentDir, false, true, { http: 7890 });
  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );

  await app.tools.get("bash").execute(
    "yolo-bash",
    { command: "curl http://127.0.0.1/" },
    undefined,
    undefined,
    app.context,
  );

  expect(app.bashToolFactory).toHaveBeenLastCalledWith(agentDir);
  expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  expect(app.filteringProxyFactory).not.toHaveBeenCalled();
});
```

Add native Write/Edit coverage with:

```ts
it("uses native Write and Edit backends in YOLO", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  const project = await mkdtemp(join(tmpdir(), "pi-permissions-project-"));
  await writeFile(
    globalConfigPath(agentDir),
    JSON.stringify({ defaultMode: "yolo" }),
  );
  const app = harness(agentDir);
  app.context.cwd = project;
  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );

  await app.tools.get("write").execute(
    "yolo-write",
    { path: "note.txt", content: "before" },
    undefined,
    undefined,
    app.context,
  );
  await app.tools.get("edit").execute(
    "yolo-edit",
    {
      path: "note.txt",
      edits: [{ oldText: "before", newText: "after" }],
    },
    undefined,
    undefined,
    app.context,
  );

  expect(await readFile(join(project, "note.txt"), "utf8")).toBe("after");
  expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
});
```

The test must not obtain a user or Guardian approval before executing either
tool.

The native Bash assertion remains:

```ts
expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
```

- [ ] **Step 3: Write the execution-time downgrade regression**

Add:

```ts
it("requires fresh authorization when YOLO ends before execution", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  await writeFile(
    globalConfigPath(agentDir),
    JSON.stringify({ defaultMode: "yolo" }),
  );
  const app = harness(agentDir);
  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );
  const event = {
    toolName: "bash",
    toolCallId: "yolo-then-default",
    input: { command: "rm -rf build" },
  };

  await expect(
    app.handlers.get("tool_call")!(event, app.context),
  ).resolves.toBeUndefined();
  await app.commands.get("default")!.handler("", app.context);

  await expect(
    app.tools.get("bash").execute(
      event.toolCallId,
      event.input,
      undefined,
      undefined,
      app.context,
    ),
  ).rejects.toThrow("no longer authorized");
});
```

- [ ] **Step 4: Write pending-approval invalidation regressions**

Add:

```ts
it("invalidates a pending Guardian review when entering YOLO", async () => {
  const review = deferred<{
    decision: "approve";
    risk: "low";
    userAuthorization: "high";
    rationale: string;
  }>();
  const reviewer = {
    invalidateSession: vi.fn(),
    review: vi.fn(async () => review.promise),
  };
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  await writeFile(
    globalConfigPath(agentDir),
    JSON.stringify({ defaultMode: "auto" }),
  );
  const app = harness(agentDir, false, true, {}, undefined, reviewer);
  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );
  const pending = app.handlers.get("tool_call")!(
    {
      toolName: "bash",
      toolCallId: "auto-to-yolo",
      input: { command: "rm -rf build" },
    },
    app.context,
  );
  await vi.waitFor(() => expect(reviewer.review).toHaveBeenCalledOnce());

  await app.commands.get("yolo")!.handler("", app.context);
  review.resolve({
    decision: "approve",
    risk: "low",
    userAuthorization: "high",
    rationale: "Stale approval.",
  });

  await expect(pending).resolves.toMatchObject({
    block: true,
    reason: expect.stringContaining("permission context changed"),
  });
  expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "YOLO");
});

it("invalidates a pending human approval when entering YOLO", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  const app = harness(agentDir);
  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );
  const choice = deferred<string>();
  app.select.mockImplementationOnce(async () => choice.promise);
  const event = {
    toolName: "bash",
    toolCallId: "default-to-yolo",
    input: { command: "rm -rf build" },
  };
  const pending = app.handlers.get("tool_call")!(event, app.context);
  await vi.waitFor(() => expect(app.select).toHaveBeenCalledOnce());

  await app.commands.get("yolo")!.handler("", app.context);
  choice.resolve("Allow Once");

  await expect(pending).resolves.toMatchObject({
    block: true,
    reason: expect.stringContaining("context changed"),
  });
  await app.commands.get("default")!.handler("", app.context);
  await expect(
    app.tools.get("bash").execute(
      event.toolCallId,
      event.input,
      undefined,
      undefined,
      app.context,
    ),
  ).rejects.toThrow("no longer authorized");
});
```

- [ ] **Step 5: Run tests and verify failure**

Run:

```bash
pnpm exec vitest --run tests/register.test.ts
```

Expected: YOLO is still classified like Default and registered tools still use
sandbox operations.

- [ ] **Step 6: Bypass policy at interception time**

In the `tool_call` handler, ensure the mode runtime immediately after loading
configuration and before `evaluateDefaultRequest`:

```ts
const runtime = ensureModeRuntime(result.config);
if (runtime.mode === "yolo") return;
```

Reuse that `runtime` later in the Default/Auto branch. Do not call the risk
evaluator, Guardian, or human approval helper before this return.

- [ ] **Step 7: Select the native backend at execution time**

At the start of each registered Bash/Write/Edit execution, after
`activateConfig(ctx)`, branch on the current mode:

```ts
if (modeRuntime?.mode === "yolo") {
  revokeApprovedCall(id);
  return bashToolFactory(ctx.cwd).execute(id, params, signal, onUpdate);
}
```

Use the equivalent native calls for Write and Edit:

```ts
return createWriteTool(ctx.cwd).execute(id, params, signal, onUpdate);
```

```ts
return createEditTool(ctx.cwd).execute(id, params, signal, onUpdate);
```

The YOLO branch must occur before `assertExecutionAuthorized`,
`sandboxCoordinator.runShared`, host filtering, and sandbox file operations.
The non-YOLO branches remain byte-for-byte equivalent in behavior.

- [ ] **Step 8: Run focused tests and type checking**

Run:

```bash
pnpm exec vitest --run tests/register.test.ts
pnpm run check
```

Expected: interception, native backend, and downgrade-race tests pass.

- [ ] **Step 9: Commit Task 3**

```bash
git add src/register.ts tests/register.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: execute YOLO calls with full access"
```

---

### Task 4: Make sandbox activation transactional across YOLO transitions

**Files:**
- Modify: `src/register.ts`
- Modify: `tests/register.test.ts`

**Interfaces:**
- Consumes: `ExecutablePermissionMode` and global `PermissionsConfig`.
- Produces: mode-aware sandbox preparation that skips initialization for YOLO
  and initializes before committing Default/Auto.

- [ ] **Step 1: Write failing YOLO-startup sandbox test**

Add:

```ts
it("starts configured YOLO even when sandbox initialization would fail", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  await writeFile(
    globalConfigPath(agentDir),
    JSON.stringify({ defaultMode: "yolo" }),
  );
  const app = harness(agentDir);
  app.sandboxManager.initialize.mockRejectedValue(
    new Error("unsupported"),
  );

  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );

  expect(app.sandboxManager.initialize).not.toHaveBeenCalled();
  expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "YOLO");
  await expect(
    app.tools.get("bash").execute(
      "yolo-no-sandbox",
      { command: "pwd" },
      undefined,
      undefined,
      app.context,
    ),
  ).resolves.toBeDefined();
});
```

- [ ] **Step 2: Write failing atomic-exit test**

Add:

```ts
it("keeps YOLO active when switching to Default cannot initialize sandbox", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  await writeFile(
    globalConfigPath(agentDir),
    JSON.stringify({ defaultMode: "yolo" }),
  );
  const app = harness(agentDir);
  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );
  app.sandboxManager.initialize.mockRejectedValueOnce(
    new Error("sandbox unavailable"),
  );

  await app.commands.get("default")!.handler("", app.context);

  expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "YOLO");
  expect(app.notify).toHaveBeenLastCalledWith(
    expect.stringContaining("sandbox unavailable"),
    "error",
  );
});
```

Add:

```ts
it("initializes sandbox before committing a switch from YOLO to Default", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  await writeFile(
    globalConfigPath(agentDir),
    JSON.stringify({ defaultMode: "yolo" }),
  );
  const app = harness(agentDir);
  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );

  await app.commands.get("default")!.handler("", app.context);

  expect(app.sandboxManager.initialize).toHaveBeenCalledOnce();
  expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "Default");
});
```

- [ ] **Step 3: Write a restored-session regression**

Add:

```ts
it("restores YOLO before deciding whether to initialize sandbox", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  const app = harness(agentDir);
  app.context.sessionManager.getBranch = (() => [
    {
      type: "custom",
      customType: "pi-permissions-state",
      data: {
        mode: "yolo",
        auto: { consecutiveDenials: 0, paused: false },
        sandboxProfile: "workspace-write",
        configFingerprint: fingerprintConfig(DEFAULT_CONFIG),
      },
    },
  ]) as any;
  app.sandboxManager.initialize.mockRejectedValue(
    new Error("must not initialize"),
  );

  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "resume" },
    app.context,
  );

  expect(app.sandboxManager.initialize).not.toHaveBeenCalled();
  expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "YOLO");
});
```

- [ ] **Step 4: Write a working-switch fast-path regression**

Add:

```ts
it("enters YOLO without waiting for a sandbox lease while working", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  const exclusive = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const coordinator = {
    runShared: async <T>(operation: () => Promise<T>) => operation(),
    runExclusive: exclusive,
  };
  const app = harness(
    agentDir,
    false,
    true,
    {},
    coordinator,
  );
  app.context.isIdle = () => false;
  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );
  const callsBeforeSwitch = exclusive.mock.calls.length;

  await app.commands.get("yolo")!.handler("", app.context);

  expect(exclusive).toHaveBeenCalledTimes(callsBeforeSwitch);
  expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "YOLO");
});
```

This test proves that a valid cached configuration can enter YOLO without
waiting behind an active sandbox coordinator lease.

- [ ] **Step 5: Write in-flight backend snapshot regressions**

Add:

```ts
it("does not unsandbox an operation that started before entering YOLO", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  const app = harness(agentDir);
  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );
  const started = deferred<void>();
  const release = deferred<void>();
  app.bashExecute.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return { content: [], details: undefined };
  });

  const running = app.tools.get("bash").execute(
    "sandboxed-before-yolo",
    { command: "pwd" },
    undefined,
    undefined,
    app.context,
  );
  await started.promise;
  expect(app.bashToolFactory).toHaveBeenLastCalledWith(
    agentDir,
    expect.objectContaining({ operations: expect.any(Object) }),
  );

  await app.commands.get("yolo")!.handler("", app.context);
  release.resolve();
  await running;

  expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "YOLO");
});

it("does not sandbox a native operation that started before leaving YOLO", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
  await writeFile(
    globalConfigPath(agentDir),
    JSON.stringify({ defaultMode: "yolo" }),
  );
  const app = harness(agentDir);
  await app.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    app.context,
  );
  const started = deferred<void>();
  const release = deferred<void>();
  app.bashExecute.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return { content: [], details: undefined };
  });

  const running = app.tools.get("bash").execute(
    "native-before-default",
    { command: "pwd" },
    undefined,
    undefined,
    app.context,
  );
  await started.promise;
  expect(app.bashToolFactory).toHaveBeenLastCalledWith(agentDir);

  await app.commands.get("default")!.handler("", app.context);
  release.resolve();
  await running;

  expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "Default");
});
```

- [ ] **Step 6: Run tests and verify failure**

Run:

```bash
pnpm exec vitest --run tests/register.test.ts
```

Expected: startup still initializes the sandbox before restored mode is known,
failed YOLO-to-Default initialization does not preserve the correct mode, and
working entry still acquires an exclusive sandbox lease.

- [ ] **Step 7: Add explicit mode-aware sandbox preparation**

In `src/register.ts`, use:

```ts
function executableMode(mode: PermissionMode): ExecutablePermissionMode {
  return mode === "plan" ? "default" : mode;
}

function requiresSandbox(
  mode: ExecutablePermissionMode,
  config: PermissionsConfig,
): boolean {
  return mode !== "yolo" && config.sandbox.enabled;
}
```

Extend the activation internals so callers can provide a target mode and an
already loaded candidate:

```ts
const activateConfigUnlocked = async (
  ctx: Pick<ExtensionContext, "cwd" | "ui" | "hasUI">,
  force = false,
  targetMode?: ExecutablePermissionMode,
  candidateOverride?: LoadedPermissionsConfig,
): Promise<LoadedPermissionsConfig> => {
  const cachedMode =
    targetMode
    ?? (modeRuntime ? executableMode(modeRuntime.mode) : undefined);
  if (!force && loaded && loadedKey === key) {
    const effectiveCachedMode =
      cachedMode ?? executableMode(loaded.config.defaultMode);
    if (
      !requiresSandbox(effectiveCachedMode, loaded.config)
      || sandboxState.kind === "ready"
    ) {
      return loaded;
    }
  }
  if (
    !force
    && activationFailure?.key === key
    && cachedMode !== "yolo"
  ) {
    throw activationFailure.error;
  }
  const candidate =
    candidateOverride ?? await loadPermissionsConfig(agentDir);
  const effectiveMode =
    cachedMode
    ?? executableMode(candidate.config.defaultMode);
};
```

Define the forwarding wrapper with a cached YOLO fast path:

```ts
const activateConfig = (
  ctx: Pick<ExtensionContext, "cwd" | "ui" | "hasUI">,
  force = false,
  targetMode?: ExecutablePermissionMode,
  candidateOverride?: LoadedPermissionsConfig,
): Promise<LoadedPermissionsConfig> => {
  if (
    targetMode === "yolo"
    && !force
    && loaded
    && loadedKey === configKey(ctx)
  ) {
    return Promise.resolve(loaded);
  }
  return sandboxCoordinator.runExclusive(() =>
    activateConfigUnlocked(
      ctx,
      force,
      targetMode,
      candidateOverride,
    ),
  );
};
```

Implement these exact branches after constructing `candidateSandbox`:

```ts
if (!requiresSandbox(effectiveMode, candidate.config)) {
  activationFailure = undefined;
  if (force) invalidatePermissionContext("permission context changed");
  loaded = candidate;
  loadedKey = key;
  baseSandboxConfig = candidateSandbox;
  sandboxState = { kind: "disabled" };
  setDefaultStatus(ctx);
  return candidate;
}
```

Construct `candidateSandbox` whenever `candidate.config.sandbox.enabled` is
true, even in YOLO, so a later transition can initialize that exact base
configuration. The branch above does not reset or initialize
`sandboxManager`, but records `disabled` after a non-cached activation so a
later restrictive transition cannot mistake an older dormant manager for the
new configuration. The outer cached-YOLO fast path leaves an already-ready,
same-configuration manager dormant and reusable.

When `requiresSandbox(...)` is true, retain the existing reset, initialize,
rollback, and failure behavior.

This allows `/yolo` to recover from a prior sandbox failure while preserving
fail-closed behavior for Default and Auto.

- [ ] **Step 8: Restore mode before session sandbox activation**

In `session_start`, load and restore a candidate runtime first:

```ts
const candidate = await loadPermissionsConfig(agentDir);
const restoredRuntime = new PermissionModeRuntime(
  candidate.config,
  pi.appendEntry.bind(pi),
);
restoredRuntime.restore(ctx.sessionManager.getBranch(), candidate.config);
const restoredMode = executableMode(restoredRuntime.mode);
await activateConfig(ctx, true, restoredMode, candidate);
modeRuntime = restoredRuntime;
setDefaultStatus(ctx);
```

Update `activateConfig` to forward `targetMode` and `candidateOverride` through
the existing exclusive coordinator.

- [ ] **Step 9: Prepare sandbox before committing a restrictive mode**

In `activateMode`, pass the requested mode into activation and call
`runtime.activate(mode)` only after activation succeeds:

```ts
const result = await activateConfig(ctx, ctx.isIdle(), mode);
if (generation !== modeMutationGeneration) return;
const runtime = ensureModeRuntime(result.config);
runtime.activate(mode);
invalidatePermissionContext("permission mode changed");
setDefaultStatus(ctx);
```

For cached configuration, return early only when the target is YOLO, sandbox
is globally disabled, or `sandboxState.kind === "ready"`. A prior sandbox
failure must not prevent a retry that targets YOLO.

- [ ] **Step 10: Run lifecycle tests and type checking**

Run:

```bash
pnpm exec vitest --run tests/register.test.ts tests/mode-runtime.test.ts tests/modes.test.ts
pnpm run check
```

Expected: YOLO startup and restore avoid initialization; successful exits
initialize first; failed exits retain YOLO.

- [ ] **Step 11: Commit Task 4**

```bash
git add src/register.ts tests/register.test.ts
git diff --cached --check
git diff --cached
git commit -m "fix: make YOLO sandbox transitions atomic"
```

---

### Task 5: Full verification, strict formatting, and documentation commit

**Files:**
- Format only the TypeScript files changed by Tasks 1–4.
- Force-add:
  `docs/superpowers/specs/2026-07-30-yolo-full-access-design.md`
- Force-add:
  `docs/superpowers/plans/2026-07-30-yolo-full-access.md`

**Interfaces:**
- Consumes: all Task 1–4 behavior.
- Produces: a clean verified feature and tracked design/plan documents.

- [ ] **Step 1: Run Biome formatting on files that were clean before this feature**

Run:

```bash
pnpm exec biome check --write src/config.ts src/state.ts src/modes/controller.ts src/mode-runtime.ts src/register.ts src/filesystem-policy.ts src/permissions/paths.ts tests/config.test.ts tests/modes.test.ts tests/mode-runtime.test.ts tests/register.test.ts tests/sandbox.test.ts
```

Expected: Biome formats the listed files only. Keep new hunks in
`src/permissions/risk.ts`, `tests/permissions.test.ts`, and
`tests/default-mode.test.ts` manually consistent with their surrounding
Biome-formatted code; do not run a bulk formatter over their pre-existing
user-owned changes.

- [ ] **Step 2: Run strict Biome validation**

Run:

```bash
pnpm exec biome check --error-on-warnings src/config.ts src/state.ts src/modes/controller.ts src/mode-runtime.ts src/register.ts src/filesystem-policy.ts src/permissions/paths.ts src/permissions/risk.ts tests/config.test.ts tests/modes.test.ts tests/mode-runtime.test.ts tests/register.test.ts tests/permissions.test.ts tests/default-mode.test.ts tests/sandbox.test.ts
```

Expected: zero errors and zero warnings.

- [ ] **Step 3: Run the complete verification suite**

Run:

```bash
pnpm run check
pnpm test
```

Expected: TypeScript passes and all Vitest files pass.

- [ ] **Step 4: Audit removed and retained configuration paths**

Run:

```bash
rg -n "projectExpansions|projectRestrictions|\\.pi/permissions\\.json" src tests
rg -n "extensions/pi-permissions/config\\.json" src tests
```

Expected:

- no runtime loader, risk, filesystem-policy, or sandbox protection references
  to `.pi/permissions.json`;
- test references exist only to prove project files are ignored or ordinary;
- the plugin-local global `config.json` remains loaded and protected.

- [ ] **Step 5: Audit Full Access routing**

Run:

```bash
rg -n "\"yolo\"|YOLO|Full Access|approvals never" src tests
```

Expected: schema, state, controller, runtime, commands, interception,
execution-time routing, lifecycle, status, and tests all contain the intended
YOLO coverage.

- [ ] **Step 6: Stage formatting hunks without capturing prior user changes**

Stage clean files normally. For the four already-modified implementation/test
files, select only YOLO/project-config and necessary Biome hunks:

```bash
git add src/config.ts src/state.ts src/modes/controller.ts src/mode-runtime.ts src/register.ts src/filesystem-policy.ts src/permissions/paths.ts tests/config.test.ts tests/modes.test.ts tests/mode-runtime.test.ts tests/register.test.ts tests/sandbox.test.ts
git add -p src/permissions/risk.ts tests/permissions.test.ts tests/default-mode.test.ts
git diff --cached --check
git diff --cached
```

Expected: no pre-existing shell-substitution, Git-metadata, Guardian prompt,
or Guardian reviewer hunks are staged.

- [ ] **Step 7: Commit any formatting-only implementation changes**

If Step 6 staged a non-empty implementation diff:

```bash
git commit -m "style: apply strict Biome checks"
```

If the staged diff is empty, do not create an empty commit.

- [ ] **Step 8: Track the approved design and plan despite global ignore**

Run:

```bash
git add -f docs/superpowers/specs/2026-07-30-yolo-full-access-design.md docs/superpowers/plans/2026-07-30-yolo-full-access.md
git diff --cached --check
git diff --cached
git commit -m "docs: document YOLO Full Access mode"
```

Expected: only the two approved documentation files are committed; the
untracked `docs/research/` report remains untouched.

- [ ] **Step 9: Final repository-state review**

Run:

```bash
git status --short
git log -6 --oneline
```

Expected: only the eight pre-existing user-modified files and the existing
untracked `docs/research/` remain; the YOLO implementation and its two
documents are committed.
