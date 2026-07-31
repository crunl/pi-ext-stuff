# Preserve Working State During Auto-to-YOLO Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a live `Auto → YOLO` switch continue the current Pi tool call
instead of ending the active agent run and changing the TUI from `working` to
`idle`, while still invalidating the old Guardian approval.

**Architecture:** Keep mode changes and review invalidation separate. The
existing per-review `AbortController` will still cancel a stale Guardian
request. Only when that cancellation is caused by the explicit transition to
YOLO will the `tool_call` hook return `undefined`, allowing Pi's core to run
the exact current call under YOLO. All other invalidations continue to return a
fail-closed block, and the outer Pi agent signal is never aborted by
`Auto → YOLO`.

**Tech Stack:** TypeScript, Pi extension hooks, Vitest, Biome 2.5.6.

## Global Constraints

- Work directly in `agent/extensions/pi-permissions`; do not create a worktree.
- Do not modify Pi core or the Homebrew core patch.
- Keep cancelling the in-flight Guardian review; a late Auto approval must
  never authorize a call after the permission context changes.
- Only a recognized `Auto → YOLO` mode transition may resume the current call.
- Session-tree changes, configuration reloads, reviewer invalidation, and
  restrictive-mode transitions remain fail-closed.
- Do not call `ctx.abort()` for `Auto → YOLO`; preserve the existing abort for
  `YOLO → Default/Auto`.
- Do not change sandbox, network, config schema, Guardian prompt, or model
  selection behavior.
- Use TDD: write the failing regression assertion, run it red, implement the
  smallest fix, then run it green.
- Run strict Biome checks on every touched source and test file before
  committing; do not mass-format unrelated files.

## File Responsibility Map

| File | Responsibility |
|---|---|
| `src/register.ts` | Distinguish a YOLO mode-switch cancellation from other review invalidations and continue only the former. |
| `tests/register.test.ts` | Prove Shift+Tab during an active Auto review keeps the tool call executable and does not abort the outer run; preserve fail-closed tests for later invalidations. |
| `docs/superpowers/specs/2026-07-30-codex-approve-for-me-design.md` | Document that YOLO has no approval gate, so a cancelled Auto review may continue the exact in-flight call under YOLO. |

### Task 1: Add the failing working-state regression test

**Files:**

- Modify: `tests/register.test.ts:2391-2468`
- Preserve: `tests/register.test.ts:516-563`

**Interfaces:**

- Consumes the existing `harness()`, `reviewSignal`, `app.context.isIdle`, and
  `Shift+Tab` shortcut seam.
- Produces a regression assertion that the pending `tool_call` resolves
  `undefined` after `Auto → YOLO`, so Pi core is allowed to execute it.

- [ ] **Step 1: Change the existing working Auto→YOLO expectation**

  In the test named
  `switches to YOLO immediately and invalidates the current Auto review`, keep
  these security assertions:

  ```ts
  expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "YOLO");
  expect(reviewSignal?.aborted).toBe(true);
  expect(app.abort).not.toHaveBeenCalled();
  ```

  After resolving the mocked late Guardian response, change the pending hook
  assertion from a blocked result to:

  ```ts
  await expect(pendingReview).resolves.toBeUndefined();
  ```

  Keep the direct `bash.execute()` assertion so the test proves the exact call
  remains executable after the hook returns `undefined`.

- [ ] **Step 2: Add the non-YOLO invalidation guard assertion**

  Leave the existing test that switches `YOLO → Auto` before the old Guardian
  promise resolves unchanged. It must continue to assert a blocked result and
  `no longer authorized`, proving that only the explicit YOLO transition gets
  the continuation behavior.

- [ ] **Step 3: Run the focused test and verify it fails**

  Run:

  ```bash
  npx vitest --run tests/register.test.ts \
    -t "switches to YOLO immediately and invalidates the current Auto review|invalidates a pending Guardian review when entering YOLO"
  ```

  Expected: the first test fails because the current implementation returns a
  `{ block: true }` result after cancelling the Auto review; the second test
  remains green.

### Task 2: Continue the exact call only after a YOLO mode transition

**Files:**

- Modify: `src/register.ts:190-202, 846-975`

**Interfaces:**

- Consumes the existing `permissionContextEpoch`, per-call
  `reviewController`, `ctx.signal`, and `modeRuntime` state.
- Produces a boolean internal predicate used by both post-review and catch
  cancellation paths; no public API or config field is added.

- [ ] **Step 1: Introduce one shared mode-change reason**

  Define a local constant near `invalidatePermissionContext`:

  ```ts
  const PERMISSION_MODE_CHANGED_REASON = "permission mode changed";
  ```

  Use it in `cyclePermissionMode` and the existing explicit mode commands when
  invalidating a mode transition. Do not replace unrelated reasons such as
  `session tree changed` or `permission context changed`.

- [ ] **Step 2: Add the narrow continuation predicate**

  Add a local helper with this behavior:

  ```ts
  const shouldContinueAfterYoloTransition = (
    ctx: Pick<ExtensionContext, "signal">,
    evaluationEpoch: number,
    reviewController: AbortController,
  ): boolean =>
    !ctx.signal?.aborted &&
    modeRuntime?.mode === "yolo" &&
    permissionContextEpoch !== evaluationEpoch &&
    reviewController.signal.reason instanceof Error &&
    reviewController.signal.reason.message === PERMISSION_MODE_CHANGED_REASON;
  ```

  This excludes an already-aborted outer agent run and excludes all non-mode
  invalidations.

- [ ] **Step 3: Use the predicate in both Auto review cancellation paths**

  At the existing `reviewSignal.aborted` check after `reviewAutoPrompt()` and
  in the `catch` block, return `undefined` only for the predicate above:

  ```ts
  if (reviewSignal.aborted) {
    if (shouldContinueAfterYoloTransition(ctx, evaluationEpoch, reviewController)) {
      return;
    }
    return {
      block: true,
      reason: "pi-permissions: permission context changed during Auto review",
    };
  }
  ```

  Keep the existing `finally` cleanup, `autoReviewer.invalidateSession()`, and
  all denial/failure handling unchanged. Returning `undefined` lets Pi's core
  `beforeToolCall` hook proceed to the already-prepared exact call; it does not
  grant a different call or reuse the stale Guardian result.

- [ ] **Step 4: Run the focused tests and typecheck**

  Run:

  ```bash
  npx vitest --run tests/register.test.ts \
    -t "switches to YOLO immediately and invalidates the current Auto review|invalidates a pending Guardian review when entering YOLO|aborts the active turn after downgrading YOLO to Default"
  npm run check
  ```

  Expected: all selected tests pass and TypeScript reports no errors.

### Task 3: Document and verify the lifecycle contract

**Files:**

- Modify: `docs/superpowers/specs/2026-07-30-codex-approve-for-me-design.md:94-107`
- Modify: `tests/register.test.ts` only if Task 2 exposes a missing regression
  seam

- [ ] **Step 1: Update the review-cancellation contract**

  Clarify the existing cancellation rule so it distinguishes restrictive
  modes from YOLO:

  ```markdown
  Cancellation or mode/config/session change invalidates the old Guardian
  decision. A restrictive target mode requires a fresh approval. YOLO has no
  approval gate, so an explicit Auto→YOLO transition may continue the exact
  in-flight tool call after invalidating the old review; the outer agent run is
  not aborted.
  ```

- [ ] **Step 2: Run the complete verification set**

  Run:

  ```bash
  npx vitest --run
  npm run check
  biome check src/register.ts tests/register.test.ts
  npm run core:check
  ```

  Expected: all tests, TypeScript, Biome, and the installed core-gate check
  exit successfully.

- [ ] **Step 3: Perform a manual TUI smoke check**

  With `~/.pi/agent/keybindings.json` mapping
  `app.thinking.cycle` away from `Shift+Tab`:

  1. Start Pi in `Auto` with a tool call that causes a visible Guardian review.
  2. While the Guardian request is pending, press `Shift+Tab` once to enter
     `YOLO`.
  3. Confirm the status changes to `YOLO`, the current tool continues, and the
     footer remains in `working` until the model actually finishes.
  4. Confirm a later `YOLO → Default/Auto` switch still aborts or requires fresh
     authorization according to the existing tests.

- [ ] **Step 4: Commit the focused change**

  Run:

  ```bash
  git add src/register.ts tests/register.test.ts docs/superpowers/specs/2026-07-30-codex-approve-for-me-design.md
  git diff --cached --check
  git diff --cached --stat
  git commit -m "fix: keep working run on Auto to YOLO switch"
  ```

  The commit must contain only this lifecycle fix, its regression coverage, and
  the corresponding contract clarification.
