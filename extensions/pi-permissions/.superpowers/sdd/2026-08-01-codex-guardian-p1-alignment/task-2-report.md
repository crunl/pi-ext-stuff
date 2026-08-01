## Task 2 report: bounded read-only Guardian tool loop

### Files changed

- `src/guardian-tools.ts` (new): read-only Guardian tool runtime adapter.
- `src/guardian-session.ts`: `Context.tools`, multi-message turns, `extend()`/`commit()` support, trunk/fork isolation.
- `src/auto-reviewer.ts`: same-attempt `toolUse -> ToolResultMessage -> final assessment` loop.
- `tests/guardian-tools.test.ts` (new): read-only exposure, injectable runtime, abort-signal propagation, invalid tool rejection.
- `tests/guardian-session.test.ts`: multi-message turn history, `Context.tools`, fork isolation, bounds.
- `tests/auto-reviewer.test.ts`: read-only tool loop, deny after tool error, fail-closed invalid tools, fork isolation, cancellation, aggregate deadline.

Existing dirty file intentionally not changed/staged by this task:

- `docs/core-execution-abort-gate.md`

### API decisions

- Added `createGuardianToolRuntime(cwd, toolFactory = createReadOnlyTools)`.
  - Uses the installed `@earendil-works/pi-coding-agent` `createReadOnlyTools(cwd)` runtime.
  - Projects each AgentTool to the `@earendil-works/pi-ai` `Tool` shape for `Context.tools`.
  - Keeps original `execute(toolCallId, params, signal, onUpdate)` in a private name map.
  - Filters exposure to exactly `read`, `grep`, `find`, `ls`.
  - Rejects unknown/non-runtime tool calls.
  - Converts valid-tool execution throws to `ToolResultMessage` with `isError: true` and sanitized text.
- `GuardianReviewSessionManager.open(key, requestPrompt, tools?)` now freezes `Context.tools`.
- `GuardianReviewLease.extend(messages)` returns a frozen context with the lease snapshot plus supplied messages.
- `GuardianReviewLease.commit(messages)` commits complete successful turns only for the trunk lease; fork commits are ignored.
- `PiAutoReviewer` gets an optional test-injectable Guardian tool runtime factory as constructor arg 4.
- `PiAutoReviewer.review()` keeps the same selected model/session/deadline across first provider call, sequential tool execution, and second provider call.
- Final parsing is done only on a final text response. Invalid/unavailable tool calls fail closed as provider failures.

### Commands and outputs

RED focused tests:

```text
$ rtk npm test -- tests/guardian-tools.test.ts tests/guardian-session.test.ts tests/auto-reviewer.test.ts
> vitest --run tests/guardian-tools.test.ts tests/guardian-session.test.ts tests/auto-reviewer.test.ts
Test Files  3 failed (3)
Tests  11 failed | 30 passed (41)
Key failures:
- Cannot find module '../src/guardian-tools.ts'
- Auto reviewer stopped with toolUse
- first.context.tools was undefined
- first.extend is not a function
```

Focused tests after implementation:

```text
$ rtk npm test -- tests/guardian-tools.test.ts tests/guardian-session.test.ts tests/auto-reviewer.test.ts
> vitest --run tests/guardian-tools.test.ts tests/guardian-session.test.ts tests/auto-reviewer.test.ts
Test Files  3 passed (3)
Tests  44 passed (44)
```

Typecheck:

```text
$ rtk npm run check
> tsc --noEmit
```

Whitespace check:

```text
$ rtk git diff --check
<no output, exit 0>
```

Core regression:

```text
$ rtk npm run core:test
> PI_PERMISSIONS_CORE_REGRESSION=1 vitest --run tests/core-execution-gate.test.ts
Test Files  1 failed (1)
Tests  1 failed (1)
Failure:
tests/core-execution-gate.test.ts
expected executions to be 0; received 1
```

Core patch check:

```text
$ rtk npm run core:check
> node scripts/install-core-patch.mjs --check
pi-permissions core patch supports pi-agent-core 0.82.1; found @earendil-works/pi-agent-core 0.83.0
```

### Concerns

- `npm run core:test` is failing against the external Homebrew Pi installation, not files changed in this task. `npm run core:check` reports the installed `/opt/homebrew` core is `@earendil-works/pi-agent-core 0.83.0`, while this repository's core patch/check currently supports `0.82.1`.
- Per instruction, I did not update `docs/core-execution-abort-gate.md`, graphify outputs, or unrelated docs.
