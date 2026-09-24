# tool-result-budget

Bounds how many characters a single turn may add to context via tool results,
so one giant tool output can never blow past pi's compaction trigger.
Overflow is written in full to a spill file and replaced in context with
head + tail + a pointer. Distributed as a single `index.ts` — pi loads it
directly, so there is **no build step**.

## How it works

- Each turn may add at most **60,000 chars** via tool results (default).
- A single result under **4,000 chars** is never shrunk.
- Anything over budget is saved whole under `~/.pi/agent/tool-spill/` and
  replaced with head + tail + a banner naming the file. Read the omitted
  middle in slices — `read <path> offset=... limit=...` — or search it with
  `grep -n`, instead of re-running the full command.
- Never compacts, never aborts, never touches pi's compaction or goal
  accounting; it only shrinks what a tool result contributes.

## Install

```bash
pi install ~/path/to/pi-ext-stuff/extensions/tool-result-budget
```

## Config

Environment overrides (chars unless noted):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_TOOL_TURN_BUDGET` | `60000` | chars per turn via tool results |
| `PI_TOOL_MIN_KEEP` | `4000` | a result under this is never shrunk |
| `PI_TOOL_SPILL_DIR` | `~/.pi/agent/tool-spill` | where full outputs are saved |

## Relationship

Standalone — Node builtins only, no cross-package imports, no host
dependencies beyond the extension API.

## Development

No check/lint/test setup — one file, no dependencies. Behaviour and the
injected system-prompt discipline are documented in the header comment of
[`index.ts`](index.ts) (measured context-growth stats included); keep them
in sync when the constants change.
