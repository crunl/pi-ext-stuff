# Default Mode Status Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the ordinary `Default` permission mode from the statusline editor border while preserving `Auto`, and verify that working-state transitions remain safe in both directions.

**Architecture:** `pi-permissions` continues publishing the complete active mode through `ctx.ui.setStatus`. The statusline status adapter normalizes `Default` to no visible mode while continuing to consume the `pi-permissions` status entry; the permission state machine itself is unchanged.

**Tech Stack:** TypeScript, Node.js test runner in `statusline`, Vitest in `pi-permissions`, Pi 0.82.1 extension APIs.

## Global Constraints

- `pi-permissions` remains the source of truth and continues publishing `"Default" | "Auto"`.
- Only the statusline presentation adapter hides the exact value `"Default"`.
- Non-default modes such as `"Auto"` remain visible.
- Do not change permission evaluation, sandboxing, reviewer behavior, approval grants, persistence, shortcuts, or command names.
- Do not use a worktree.

---

### Task 1: Hide Default in the statusline adapter

**Files:**
- Modify: `/Users/x1a2h1/.pi/agent/extensions/statusline/src/status-mode.ts`
- Test: `/Users/x1a2h1/.pi/agent/extensions/statusline/tests/status-mode.test.ts`

**Interfaces:**
- Consumes: `ReadonlyMap<string, string>` from `footerData.getExtensionStatuses()`.
- Produces: `partitionExtensionStatuses(statuses): { mode: string | undefined; remaining: Array<[string, string]> }`, where `mode` is `undefined` only for a missing status or the exact status `"Default"`.

- [ ] **Step 1: Write the failing adapter tests**

Change the Default formatting expectation and add explicit partition assertions:

```ts
test("hides Default from the compact model status", () => {
  assert.equal(
    formatModelStatus(info, undefined),
    "(tuzi) gpt-5.6-sol-fast • xhigh",
  );
});

test("normalizes Default while preserving Auto", () => {
  const defaultResult = partitionExtensionStatuses(new Map([
    ["other", "Indexing"],
    ["pi-permissions", "Default"],
  ]));
  assert.equal(defaultResult.mode, undefined);
  assert.deepEqual(defaultResult.remaining, [["other", "Indexing"]]);

  const autoResult = partitionExtensionStatuses(
    new Map([["pi-permissions", "Auto"]]),
  );
  assert.equal(autoResult.mode, "Auto");
});
```

- [ ] **Step 2: Run the focused statusline test and verify RED**

Run:

```bash
node --test tests/status-mode.test.ts
```

Expected: the Default normalization assertion fails because the adapter returns `"Default"`.

- [ ] **Step 3: Implement exact Default normalization**

Update `partitionExtensionStatuses`:

```ts
const publishedMode = statuses.get("pi-permissions");
return {
  mode: publishedMode === "Default" ? undefined : publishedMode,
  remaining: [...statuses.entries()].filter(([key]) => key !== "pi-permissions"),
};
```

Do not teach `formatModelStatus` about permission-mode names.

- [ ] **Step 4: Run statusline checks and verify GREEN**

Run:

```bash
node --test tests/status-mode.test.ts
npm test
npm run check
```

Expected: all statusline tests and TypeScript checks pass.

- [ ] **Step 5: Commit the statusline change**

```bash
git add src/status-mode.ts tests/status-mode.test.ts
git commit -m "feat: hide default permission mode from statusline"
```

---

### Task 2: Strengthen bidirectional working-transition coverage

**Files:**
- Test: `/Users/x1a2h1/.pi/agent/extensions/pi-permissions/tests/mode-runtime.test.ts`
- Test: `/Users/x1a2h1/.pi/agent/extensions/pi-permissions/tests/register.test.ts`

**Interfaces:**
- Consumes: `PermissionModeRuntime.activate`, `cycle`, `flushPending`, `beginReview`, and `endReview`.
- Produces: regression evidence that working transitions change only `pendingMode`, preserve the active approval mode, and apply after settlement.

- [ ] **Step 1: Add a focused Auto-to-Default runtime test**

```ts
it("keeps Auto active until a working transition can settle", () => {
  const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
  runtime.activate("auto", { idle: true });
  runtime.beginReview("active-review");

  expect(runtime.activate("default", { idle: false })).toEqual({
    active: "auto",
    pending: "default",
  });
  expect(runtime.mode).toBe("auto");
  expect(runtime.flushPending({ idle: true })).toBe("auto");

  runtime.endReview("active-review");
  expect(runtime.flushPending({ idle: true })).toBe("default");
});
```

- [ ] **Step 2: Run the focused runtime test**

Run:

```bash
npx vitest run tests/mode-runtime.test.ts
```

Expected: PASS because this task verifies and locks existing intended behavior rather than changing production behavior.

- [ ] **Step 3: Confirm integration coverage remains explicit**

Keep the existing register integration tests that prove:

```text
Default working → pending Auto → agent_settled → active Auto
Auto review active → pending Default → review completes → agent_settled → active Default
working cycle twice → pending transition cancelled
```

If their names or assertions no longer state those facts directly, tighten only the test names or assertions; do not change production code.

- [ ] **Step 4: Run all pi-permissions verification**

Run:

```bash
npx vitest run tests/mode-runtime.test.ts tests/register.test.ts
npm test
npm run check
git diff --check
```

Expected: 0 test failures, 0 TypeScript errors, and no whitespace errors.

- [ ] **Step 5: Commit the regression coverage**

```bash
git add tests/mode-runtime.test.ts tests/register.test.ts
git commit -m "test: lock working permission mode transitions"
```

---

### Task 3: Cross-repository review

**Files:**
- Review: `/Users/x1a2h1/.pi/agent/extensions/statusline/src/status-mode.ts`
- Review: `/Users/x1a2h1/.pi/agent/extensions/pi-permissions/src/modes/controller.ts`
- Review: `/Users/x1a2h1/.pi/agent/extensions/pi-permissions/src/mode-runtime.ts`
- Review: `/Users/x1a2h1/.pi/agent/extensions/pi-permissions/src/register.ts`

**Interfaces:**
- Consumes: published extension status and pending-mode lifecycle.
- Produces: final evidence that presentation filtering does not change permission state.

- [ ] **Step 1: Review repository diffs**

Run in each repository:

```bash
git diff HEAD^ --check
git show --stat --oneline HEAD
git status --short
```

Expected: only the planned files differ and both worktrees are clean after commits.

- [ ] **Step 2: Verify the visible outcomes**

Confirm from tests and code:

```text
Default → (provider) model • effort
Auto    → Auto•(provider) model•effort
```

Confirm `pi-permissions` still calls:

```ts
ctx.ui.setStatus("pi-permissions", modeRuntime?.statusLabel ?? "Default");
```

- [ ] **Step 3: Report verification and remaining limitations**

Report exact test counts and commands. State that component rendering is covered at formatter/adapter level; no interactive terminal snapshot test is required because the change does not introduce a custom TUI component.
