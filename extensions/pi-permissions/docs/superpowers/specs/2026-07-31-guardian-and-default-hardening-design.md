# Guardian Parity and Default Hardening Design

**Date:** 2026-07-31

**Status:** Approved

**Scope:** Resolve and commit the eight pre-existing Guardian/Default/risk
working-tree changes without changing YOLO semantics.

## Goal

Make the Pi Auto reviewer behaviorally compatible with the current Codex
Guardian boundary while keeping Pi-specific deterministic protections in a
separate Default/Auto policy layer.

The implementation must:

- align Guardian policy, output schema, parsing, and post-denial approval
  context with Codex;
- preserve Pi's deterministic hard blocks for protected paths, private
  networks, and unsafe Git metadata;
- remove false-positive Git mutation blocks caused by shell names appearing
  in ordinary arguments;
- keep YOLO as Full Access, bypassing both deterministic policy and Guardian;
- turn the current eight-file working tree into reviewable atomic commits;
- pass strict Biome, TypeScript, focused tests, and the full test suite.

## Normative Upstream Reference

Behavioral parity is pinned to OpenAI Codex commit
`789c72dcf62d7439863d4d2846454f05b3d51db6`.

The normative files are:

- `codex-rs/core/src/guardian/policy.md`
- `codex-rs/core/src/guardian/policy_template.md`
- `codex-rs/core/src/guardian/prompt.rs`
- `codex-rs/core/src/guardian/review.rs`
- `codex-rs/core/src/guardian/mod.rs`

Future Codex changes are not silently inherited. Updating the pin requires a
new review of the prompt, schema, parser, retry/failure behavior, and approval
context.

## Architecture

The permission pipeline has three distinct layers:

```text
YOLO
  └─ bypass all policy and review, then execute with Full Access

Default / Auto
  └─ deterministic Pi policy (ARC-like boundary)
       ├─ protected filesystem paths
       ├─ private/special network targets
       ├─ shell and Git structural checks
       └─ explicit deny rules
            ↓ only requests eligible for review
       mode policy
            ├─ Default → user approval
            └─ Auto → Codex-compatible Guardian
```

The deterministic layer and Guardian must not duplicate responsibility:

- deterministic policy rejects structurally unsafe or locally forbidden
  operations before any model review;
- Guardian evaluates intrinsic risk and user authorization for operations that
  would otherwise require human approval;
- Guardian parsing validates the response contract but does not reimplement
  the policy prompt;
- YOLO returns before either layer is evaluated.

## Guardian Behavioral Parity

### Policy and output contract

The bundled policy template, default tenant policy, and output instructions
must match the pinned Codex source. Local naming may differ only where needed
to describe Pi instead of Codex; such substitutions must not alter policy
meaning.

The structured result fields are:

```ts
interface GuardianAssessmentPayload {
  outcome: "allow" | "deny";
  risk_level?: "low" | "medium" | "high" | "critical";
  user_authorization?: "unknown" | "low" | "medium" | "high";
  rationale?: string;
}
```

Only `outcome` is required.

### Parser behavior

The parser must mirror the pinned Codex behavior:

1. Parse the whole response as JSON.
2. If that fails, accept the substring from the first `{` through the last
   `}` as the thin surrounding-prose recovery path.
3. Reject missing payloads, non-JSON responses, non-object responses, invalid
   enum values, and missing/invalid `outcome`.
4. For an allowed assessment without `risk_level`, default risk to `low`.
5. For a denied assessment without `risk_level`, default risk to `high`.
6. Default missing `user_authorization` to `unknown`.
7. Replace a missing or blank rationale with the same allow/deny fallback
   rationale used by Codex.
8. Do not enforce high/critical policy consistency a second time in the
   parser. The policy prompt owns the `outcome`.

The existing uncommitted `approvalOverride` parser argument and the
high/critical parser rejection branches must therefore be removed.

### Post-denial user approval

When the user explicitly approves one previously denied action:

- bind approval to the exact stored action fingerprint;
- add a developer-context entry beginning with Codex's pinned marker:
  `The user has manually approved a specific action that was previously
  \`Rejected\`.`;
- include the exact approved action in that context;
- retry only that action once;
- let Guardian reassess it from the updated authorization evidence;
- do not convert the user approval directly into unconditional execution;
- do not broaden the approval to similar commands or later actions.

### Failure behavior

Existing fixed limits remain unchanged:

- timeout: 90 seconds;
- maximum attempts: 3;
- consecutive-denial pause: 3.

Cancellation and permission-context changes remain fail closed. Timeout stays
distinguishable from other Guardian failures. This design does not expand the
scope to reproduce Codex's complete review-session manager, telemetry, or
protocol event model.

## Shell and Git Command Boundary

### Shell syntax scanner

One quote/escape-aware scanner should derive syntax facts used by risk
classification:

- executable command substitution: `$()` or backticks outside single quotes
  and without escaping;
- active redirects: `<` or `>` outside quotes and without escaping;
- actual nested shell execution.

An ordinary argument containing the words `bash`, `sh`, `zsh`, `fish`, or
`dash` is not nested shell execution.

Nested shell execution requires the parsed executable to be one of those
shells and the arguments to invoke command evaluation, such as `-c` or the
shell's equivalent supported by the existing parser.

Required non-regression examples:

```text
git commit -m "document bash support"  → not nested shell
git add docs/fish.md                   → not nested shell
bash -c "git commit -am update"        → nested shell
echo "$(rm -rf build)"                 → executable substitution
echo '$(rm -rf build)'                 → literal, no substitution
```

### Git metadata write grants

Additional Git metadata write roots may be granted only when the complete
command is:

- a single parsed command segment;
- a recognized Git mutation or supported `gh pr checkout`;
- free of active redirects;
- free of executable substitution;
- not executed through a nested shell.

Compound commands, pipelines, substitutions, redirects, and nested shells
must not inherit Git metadata write access.

## Git Metadata Ownership

Git repository discovery and ownership validation should move out of
`default-mode.ts` into a focused module. Its public result must expose only
what the policy evaluator needs:

```ts
type GitMetadataResult =
  | {
      ok: true;
      configPath: string;
      writeRoots: string[];
    }
  | {
      ok: false;
      reason: string;
    };
```

The module must:

- reject `.git` symbolic links;
- reject filesystem-root metadata paths;
- require resolved metadata targets to be directories;
- validate ordinary `.git` directory structure;
- validate linked-worktree back-pointers and `commondir`;
- validate submodule `core.worktree` ownership;
- return stable, deduplicated write roots;
- fail closed on malformed pointers, missing structures, ownership mismatch,
  or filesystem errors.

It must not:

- rewrite Git remotes;
- convert SSH remotes to HTTPS;
- read SSH private keys;
- grant access outside verified metadata roots;
- change YOLO behavior.

The minimal `core.worktree` parser may remain local to this module. It must
handle the currently tested quoted and unquoted values; broader Git config
parsing is outside this scope.

## Commit Boundaries

Implementation should produce four atomic commits:

1. `fix: align Guardian assessment parsing with Codex`
   - policy/schema/parser/post-denial context and their tests;
2. `fix: classify nested shell execution precisely`
   - shared shell syntax scanner, Git single-command gate, and tests;
3. `fix: validate Git metadata ownership`
   - extracted Git metadata module, Default integration, and tests;
4. `docs: record Codex Guardian alignment`
   - updated spec/research documentation only.

Formatting changes belong in the functional commit that owns the file. There
must not be a repository-wide formatting commit.

## Testing

### Guardian parity fixtures

Tests must cover:

- strict JSON allow with only `outcome`;
- strict JSON deny with only `outcome`;
- surrounding-prose JSON recovery;
- invalid JSON and invalid enum values;
- missing `outcome`;
- blank rationale fallbacks;
- structurally valid high/critical allow accepted by the parser;
- exact post-denial approval marker and action binding;
- stale or non-matching approval does not authorize another action.

### Shell and Git tests

Tests must cover:

- the false-positive `bash` commit-message and `fish` path examples;
- real `shell -c` nesting;
- quoted, escaped, and active substitutions/redirections;
- single Git mutation eligibility;
- compound/pipeline/substitution/redirect rejection;
- ordinary repositories, linked worktrees, and submodules;
- `.git` symlink, invalid back-pointer, invalid common directory, filesystem
  root, and ownership mismatch rejection;
- SSH remote host extraction without remote rewriting.

### Integration gates

The final tree must pass:

```sh
npm run check
npm test
biome check --error-on-warnings \
  src/auto-review-request.ts \
  src/auto-reviewer.ts \
  src/default-mode.ts \
  src/permissions/risk.ts \
  tests/auto-review-request.test.ts \
  tests/auto-reviewer.test.ts \
  tests/default-mode.test.ts \
  tests/permissions.test.ts
```

If Git metadata code is extracted, its source and test files must be added to
the Biome command.

The full suite may require permission to bind the filtering proxy to
`127.0.0.1`; an `EPERM` bind failure inside the outer sandbox is an
environment limitation and must be rerun with local loopback permission.

## Non-Goals

- Reimplementing Codex's complete reusable Guardian child-session manager.
- Reproducing Codex analytics or app-server Guardian lifecycle events.
- Changing Guardian provider/model selection.
- Changing sandbox profiles or network allowlists.
- Changing Default, Auto, or YOLO mode switching.
- Changing the Homebrew Pi core execution gate.
- Automatically tracking future Codex `main`.

## Acceptance Criteria

The work is complete when:

- Guardian parser behavior matches pinned Codex commit `789c72d`;
- post-denial approval remains exact-action scoped and Guardian-reviewed;
- shell names in ordinary arguments no longer cause HARD blocks;
- real nested shells and executable substitutions remain reviewable or
  blocked according to existing policy;
- Git metadata roots are granted only after ownership validation;
- SSH remotes remain supported and unchanged;
- YOLO still bypasses all Guardian and deterministic policy evaluation;
- the eight pre-existing dirty files have been resolved into atomic commits;
- strict Biome, TypeScript, focused tests, and the full suite pass;
- no unrelated user-owned changes are staged or overwritten.
