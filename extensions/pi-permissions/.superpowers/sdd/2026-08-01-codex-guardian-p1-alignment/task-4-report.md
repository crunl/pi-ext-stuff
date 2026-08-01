# Task 4 report: Codex Guardian P1 alignment verification

## Files changed

- `tests/register.test.ts`
- `tests/default-mode.test.ts`
- `tests/auto-reviewer.test.ts`
- `src/guardian-policy.ts`
- `src/guardian-session.ts`
- `src/register.ts`
- `docs/superpowers/specs/2026-07-30-codex-approve-for-me-design.md`
- `docs/research/2026-07-30-codex-approve-for-me-alignment.md`
- `.superpowers/sdd/2026-08-01-codex-guardian-p1-alignment/task-4-report.md`

Preserved unstaged and unmodified by this task:

- `docs/core-execution-abort-gate.md`

Graphify outputs were not updated.

## Implementation notes

- Added end-to-end regression assertions for:
  - Default/Auto sandbox parity and Auto reviewer workspace-write/network snapshot.
  - Guardian allow exact-call binding to tool/input/cwd/config fingerprint.
  - Guardian deny plus exact `/approve` behavior already present and preserved.
  - Auto provider/parse/timeout failure fail-closed behavior in UI and headless mode.
  - YOLO as the only bypass path; Guardian-approved Auto calls still execute through the captured sandboxed path after future mode switches to YOLO.
  - Extra Git/private-network hard blocks as outer Pi policy, not Guardian decisions.
  - Custom-tool calls without MCP metadata remaining `custom_tool_call` with no invented connector/account fields.
  - Guardian read-only tool surface excludes shell.
- Updated the design/research docs with implemented P1 behavior, Codex `main` SHA `6751b54cae32b23786001e2414d749a9916201e1`, the `789c72d...6751b54` GitHub compare, runtime drift notes, and remaining P2 boundaries.
- Applied only Biome formatting/import-order fixes in `guardian-policy.ts`, `guardian-session.ts`, and `register.ts`.

## Verification commands and output

### `rtk npx vitest --run tests/register.test.ts tests/default-mode.test.ts tests/auto-reviewer.test.ts`

Final output:

```text
 RUN  v4.1.10 /Users/x1a2h1/.pi/agent/extensions/pi-permissions
 Test Files  3 passed (3)
      Tests  249 passed (249)
   Start at  15:42:08
   Duration  2.80s (transform 465ms, setup 0ms, import 2.33s, tests 2.25s, environment 0ms)
```

### `rtk npm test`

Output:

```text
> vitest --run
 RUN  v4.1.10 /Users/x1a2h1/.pi/agent/extensions/pi-permissions
 ❯ tests/filtering-proxy.test.ts (9 tests | 9 failed) 14ms
     × forwards only approved HTTP CONNECT hosts to the upstream proxy 7ms
     × applies the same host boundary to SOCKS5 traffic 2ms
     × rejects private targets even when they appear in the approved host set 0ms
     × supports allowed wildcards while giving denied domains precedence 0ms
     × rejects the whole host when any DNS result is private 1ms
     × caches validated DNS results for the command lifetime 1ms
     × fails closed when DNS resolution fails 0ms
     × does not establish an upstream connection after close wins a pending resolution 1ms
     × destroys an upstream CONNECT handshake that is still in flight 0ms
 Test Files  1 failed | 22 passed | 1 skipped (24)
      Tests  9 failed | 537 passed | 1 skipped (547)
   Start at  15:41:25
   Duration  4.42s (transform 1.45s, setup 0ms, import 9.72s, tests 3.28s, environment 2ms)
Failed tests: 9 filtering-proxy cases
Error: listen EPERM: operation not permitted 127.0.0.1
```

Limitation: full suite is blocked in this sandbox by loopback listen permission for `tests/filtering-proxy.test.ts`. Per instruction, this failed output was recorded and the command was not repeatedly retried.

### `rtk npm run check`

Final output after fixing the test type issue:

```text
> tsc --noEmit
```

### `rtk npm run core:test`

Output:

```text
> PI_PERMISSIONS_CORE_REGRESSION=1 vitest --run tests/core-execution-gate.test.ts
 RUN  v4.1.10 /Users/x1a2h1/.pi/agent/extensions/pi-permissions
 ❯ tests/core-execution-gate.test.ts (1 test | 1 failed) 195ms
     × does not invoke an abort-ignorant prepared tool after a later preflight aborts 194ms
 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  15:41:55
   Duration  376ms (transform 20ms, setup 0ms, import 81ms, tests 195ms, environment 0ms)
AssertionError: expected 1 to be +0 // Object.is equality
- Expected
+ Received
- 0
+ 1
 ❯ tests/core-execution-gate.test.ts:91:24
```

Limitation: this matches the known external core mismatch area; `core:check` below confirms installed `pi-agent-core` is `0.83.0` while the repository patch supports `0.82.1`. I did not modify `docs/core-execution-abort-gate.md` or core patch files to bypass it.

### `rtk npm run core:check`

Output:

```text
> node scripts/install-core-patch.mjs --check
pi-permissions core patch supports pi-agent-core 0.82.1; found @earendil-works/pi-agent-core 0.83.0
```

### Focused Biome check

Command:

```bash
rtk npx @biomejs/biome check --error-on-warnings src/guardian-policy.ts src/guardian-session.ts src/register.ts tests/register.test.ts tests/default-mode.test.ts tests/auto-reviewer.test.ts
```

Final output:

```text
Checked 6 files in 79ms. No fixes applied.
```

Initial sandboxed attempt failed before running Biome because `npx` could not access the registry through the local proxy:

```text
npm error code EPERM
npm error syscall connect
npm error FetchError: request to https://registry.npmmirror.com/@biomejs%2fbiome failed, reason: connect EPERM 127.0.0.1:7890 - Local (0.0.0.0:0)
```

The final focused Biome check was run with approved network access.

### `rtk git diff --check`

Output: no output, exit 0.

## Concerns

- `npm test` is not fully green in the current sandbox because the filtering proxy tests cannot bind `127.0.0.1` (`listen EPERM`).
- `npm run core:test` / `npm run core:check` are blocked by the known external `pi-agent-core 0.83.0` vs repository patch `0.82.1` mismatch.
- No behavioral runtime code was changed beyond formatting/import ordering; Task 4 is regression and documentation focused.
