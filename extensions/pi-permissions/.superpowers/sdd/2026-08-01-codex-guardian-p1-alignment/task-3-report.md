# Task 3 Report: Align policy injection and Auto failure semantics

## Changed files

- `src/guardian-policy.ts`
- `src/auto-review-request.ts`
- `src/auto-reviewer.ts`
- `src/guardian-session.ts`
- `src/register.ts`
- `tests/auto-review-request.test.ts`
- `tests/auto-reviewer.test.ts`
- `tests/register.test.ts`
- `docs/superpowers/specs/2026-07-30-codex-approve-for-me-design.md`

## RED verification

Command:

```text
rtk npm test -- tests/auto-review-request.test.ts tests/auto-reviewer.test.ts tests/register.test.ts
```

Output:

```text
> vitest --run tests/auto-review-request.test.ts tests/auto-reviewer.test.ts tests/register.test.ts
 RUN  v4.1.10 /Users/x1a2h1/.pi/agent/extensions/pi-permissions
 ❯ tests/auto-reviewer.test.ts (33 tests | 1 failed) 803ms
     × uses a trusted Guardian policy from the reviewer context in the system prompt 18ms
 ❯ tests/register.test.ts (126 tests | 5 failed) 1361ms
     × blocks after final Guardian timeout failure with UI instead of opening human fallback 8ms
     × blocks after final Guardian provider failure with UI instead of opening human fallback 5ms
     × blocks after final Guardian parse failure with UI instead of opening human fallback 2ms
     × fails closed with a generic reason on reviewer failure without UI and records no approval 2ms
     × passes only trusted RegisterExtensionOptions policy source output to Auto reviewer 2ms
 Test Files  2 failed | 1 passed (3)
      Tests  6 failed | 174 passed (180)
```

Expected RED failures were observed:

- Trusted `guardianPolicy` was ignored by `PiAutoReviewer`, so the default policy stayed in the `GuardianReviewSessionManager` system prompt.
- Interactive Auto reviewer failure still opened the human approval path.
- Headless Auto reviewer failure still returned the older `interactive approval is required` reason.
- `RegisterExtensionOptions.guardianPolicySource` was not called.

## GREEN verification

Command:

```text
rtk npm test -- tests/auto-review-request.test.ts tests/auto-reviewer.test.ts tests/register.test.ts
```

Output:

```text
> vitest --run tests/auto-review-request.test.ts tests/auto-reviewer.test.ts tests/register.test.ts
 RUN  v4.1.10 /Users/x1a2h1/.pi/agent/extensions/pi-permissions
 Test Files  3 passed (3)
      Tests  183 passed (183)
   Start at  15:26:25
   Duration  3.65s (transform 490ms, setup 0ms, import 3.58s, tests 2.10s, environment 0ms)
```

Command:

```text
rtk npm run check
```

Output:

```text
> tsc --noEmit
```

Command:

```text
rtk npm test
```

Sandbox output:

```text
> vitest --run
 RUN  v4.1.10 /Users/x1a2h1/.pi/agent/extensions/pi-permissions
 ❯ tests/filtering-proxy.test.ts (9 tests | 9 failed) 12ms
 Test Files  1 failed | 22 passed | 1 skipped (24)
      Tests  9 failed | 530 passed | 1 skipped (540)
Error: listen EPERM: operation not permitted 127.0.0.1
```

The full suite requires local `127.0.0.1` listener permissions for filtering proxy tests, so it was rerun outside the sandbox.

Non-sandbox output:

```text
> vitest --run
 RUN  v4.1.10 /Users/x1a2h1/.pi/agent/extensions/pi-permissions
 Test Files  23 passed | 1 skipped (24)
      Tests  539 passed | 1 skipped (540)
   Start at  15:27:26
   Duration  3.81s (transform 1.15s, setup 0ms, import 8.03s, tests 3.34s, environment 2ms)
```

Command:

```text
rtk git diff --check
```

Output:

```text

```

## API and security decisions

- Added `GuardianPolicySource` to `RegisterExtensionOptions`:
  - Input: `{ cwd: string; configFingerprint: string }`.
  - Output: complete policy string or `undefined`.
- Added `guardianPolicy?: string` to `AutoReviewerContext`.
- Kept policy out of `PermissionsConfig`, project overlays, user messages, tool results, and model output. The only injection path is the trusted `RegisterExtensionOptions.guardianPolicySource` hook.
- Moved Codex Guardian policy template, default policy, output contract, and renderer into `src/guardian-policy.ts`.
- Kept `AUTO_REVIEW_SYSTEM_PROMPT` as a compatibility export from `src/auto-review-request.ts`, rendered with the default policy.
- Rejected empty and overlong supplied policies with explicit errors; no supplied policy is silently truncated. The length bound is `MAX_GUARDIAN_POLICY_CHARACTERS = 16_000`.
- Passed the selected trusted policy through `register.ts` → `AutoReviewerContext` → `PiAutoReviewer` → `GuardianReviewSessionManager.open(...)`.
- Updated `GuardianReviewSessionManager` so the actual lease context system prompt uses the selected/default rendered prompt, and a changed prompt creates a fresh trunk instead of reusing prior policy context.
- Changed Auto reviewer `error` results to block in both UI and headless modes:
  - `{ block: true, reason: "pi-permissions Auto review failed closed; the action was not run" }`
  - No `requestHumanApproval()` fallback in Auto error paths.
  - Failed provider/parse/timeout reviews do not record an exact approved-call capability.
- Preserved Default-mode human approval behavior; added a regression test showing Default still opens the human approval select and never calls the Auto reviewer.
- Preserved Task 1/2 behavior and did not update graphify outputs.

## Concerns

- `docs/core-execution-abort-gate.md` was already modified before Task 3 work began. It was not changed for Task 3 and must not be staged in the Task 3 commit.
