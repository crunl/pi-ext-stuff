# Codex runtime migration gate

Status: dependency upgrade complete; production runtime migration is not enabled.

## Scope and invariants

The intended alignment covers per-action escalation, effective filesystem defaults,
default network approval behavior, and temporary write roots. It does not modify
Pi host, pi-core, MCP bypass, or Guardian's independent worker ownership.

The Engine remains the authorization authority. A runtime transports an immutable
execution request; it must not silently derive additional authority or replay a
command after an ambiguous failure. Existing SRT enforcement remains active until
the replacement has passed its execution contract.

## Pi dependency gate

Official npm metadata and the published 0.85.1 package were inspected on 2026-09-05.
The ExtensionAPI types, tool definitions, and bash/write/edit implementations match
the previously installed 0.85.0 versions for the interfaces used by this extension.

The project now validates against pi-coding-agent and pi-ai 0.85.1. The version-scoped
pi-server packageExtensions workaround has been removed: upstream fixed the
accidental publication of experimental client/server modules. The normal root SDK
entry remains the supported import; experimental subpaths are not an alternative.

Validation after installation:

- `pnpm install --frozen-lockfile --registry=https://registry.npmjs.org/`: passed.
- `npm run check`: passed.
- `npm run test`: 36 files, 819 passed, 1 skipped.
- `git diff --check`: passed.

## Why the sandbox command needs a gate

The tested local binary reports `codex-cli 0.153.1`; the same version exists in the
official `@openai/codex` npm registry. The app-bundled absolute path used in the
temporary probes is not a proposed installation requirement.

Source inspected: openai/codex commit
`2bd71f96d41809b95ea881429a1b68eb48d089b6`. Source inspection and shipped-binary
measurements are separate evidence; the source commit is not asserted to be the
exact build revision of the installed binary.

`codex sandbox --sandbox-state-json` accepts explicit filesystem/network state, but
`run_command_under_sandbox()` still loads configuration before applying that state.
It constructs the child environment with `shell_environment_policy`, and can start
a configured network proxy. The state therefore is not, by itself, a complete
request-level environment/configuration isolation interface.

Relevant source locations:

- `codex-rs/cli/src/debug_sandbox.rs`: configuration loading, environment generation,
  explicit permission state, optional proxy, and child lifecycle.
- `codex-rs/config/src/merge.rs`: recursive table merging; an empty `set` table does
  not erase lower-layer environment overrides.
- `codex-rs/protocol/src/shell_environment.rs`: configured `set` is applied after
  inheritance/excludes and before `include_only`.

Do not disable managed requirements merely to make a probe pass. Do not copy,
overwrite, or temporarily rewrite the user's Codex configuration. Ordinary exit
status or stderr text is not an authoritative per-capability denial event.

The bounded macOS probe confirmed workspace writes, external read-only access,
automatic read-only `.git`/`.agents`/`.codex` paths, and exact additional write
roots that do not include siblings or parents. Restricted networking blocked a
local TCP fixture while the enabled-network control connected. Adapter-style
process-group cancellation cleaned up the tracked child. A denied write returned
a nonzero exit status.

The same probe positively reproduced configured environment injection despite an
explicit sandbox state. Its 16 successful observations include confirmation of
this limitation: the probe's success is not a green migration gate. It did not
prove that arbitrary detached descendants are always cleaned up.

A separate same-name environment check reproduced the remaining isolation gap:
the caller provided `PI_CONTRACT_CANARY=exact`, the command configuration set that
key to `ambient`, and `include_only` allowed only that key. The child assertion
that the value remained `exact` exited 1; the positive control asserting `ambient`
exited 0 and emitted a fixed success marker. Filtering alone therefore does not
preserve the requested environment. All values in this probe were non-secret.

## Alternative interface under evaluation

The same binary exposes **experimental** `codex exec-server --listen stdio`.
It accepts request-level argv, cwd, environment, and sandbox permissions, with
correlated process lifecycle messages. A local stdio invocation does not require
a remote executor, an LLM call, or a persistent background service.

The initial disposable probe in `/tmp` measured:

- A configured fixed canary value did not overwrite the value in `process/start.env`.
- The start response reported `sandboxType: macosSeatbelt`.
- The child returned exit code 0.
- Closing stdin after completion caused the server to exit with code 0.

This is a narrow smoke check, not production acceptance. The CLI still loads
configuration for other concerns such as telemetry; environment isolation must not
be misrepresented as complete configuration independence. No experimental runtime
has been added as a project dependency or selected by the extension.

## Outstanding acceptance checks

- Decide whether the experimental, pinned local stdio interface is acceptable.
- Verify exact grants, protected metadata, restricted networking with a working
  positive control, and cancellation/timeout cleanup of owned descendants.
- Verify framing/output bounds, startup failures, unexpected disconnects, and
  cleanup failures before granting production authority.
- Pin the distributed runtime and validate its actual wire contract; fail closed
  on incompatible binaries or responses.
- Derive TMPDIR policy and execution environment from the same captured snapshot.
- Preserve explicit hard rules and delegated authority ceilings during escalation.
- Verify Linux separately; macOS results do not establish cross-platform parity.

Only after acceptance should production adapters, grants, and default configuration
be migrated together. Do not activate a partial migration that widens permissions
while leaving enforcement or reviewer context on the old interpretation.
