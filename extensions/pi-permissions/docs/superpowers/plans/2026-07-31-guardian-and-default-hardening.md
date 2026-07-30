# Guardian Parity and Default Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the eight pre-existing Guardian/Default/risk working-tree
changes into Codex-compatible Guardian behavior and independently reviewable
Pi deterministic-policy hardening.

**Architecture:** Preserve a three-layer boundary: YOLO bypasses policy,
Default/Auto first pass through deterministic Pi protections, and only
review-eligible Auto requests reach a Codex-compatible Guardian. Guardian
parsing mirrors pinned Codex behavior without reimplementing policy; shell/Git
syntax and Git metadata ownership live in focused deterministic modules.

**Tech Stack:** TypeScript ESM, Pi extension API 0.82.1, Typebox, Vitest 4,
Biome, Node.js filesystem APIs.

## Global Constraints

- Normative Guardian reference is OpenAI Codex commit
  `789c72dcf62d7439863d4d2846454f05b3d51db6`.
- Work directly in the existing checkout; do not create a worktree.
- Preserve the meaning of all eight pre-existing dirty files while correcting
  the reviewed defects; never reset, overwrite, or discard their hunks.
- Keep `config.json` with `"defaultMode": "default"`.
- Do not change Default/Auto/YOLO switching, sandbox profiles, network
  allowlists, Guardian model selection, or the Homebrew core execution gate.
- YOLO must continue returning before deterministic risk evaluation, Guardian,
  and human approval.
- SSH remotes remain supported and unchanged; never rewrite SSH to HTTPS.
- Fixed Guardian timeout/attempt/denial limits remain 90 seconds, 3 attempts,
  and 3 consecutive denials.
- Use TDD for every behavioral change: write the failing test, observe the
  expected failure, add the minimum implementation, then observe green.
- Run strict Biome on every file owned by a task before committing.
- Stage only task-owned hunks. Inspect `git diff --cached` before every commit.

---

## File Responsibility Map

- `src/auto-review-request.ts`: pinned Guardian policy, trusted transcript
  framing, exact-action approval context, structured result parsing.
- `src/auto-reviewer.ts`: reviewer invocation and parsing integration.
- `src/register.ts`: `/approve` UI flow and exact retry message.
- `src/permissions/risk.ts`: shell tokenization, syntax facts, risk
  classification, and Git-mutation command eligibility.
- `src/git-metadata.ts`: repository metadata discovery, ownership validation,
  remote-host reading, and metadata write roots.
- `src/default-mode.ts`: deterministic decision orchestration only; consumes
  risk and Git metadata modules.
- `tests/auto-review-request.test.ts`: pinned parser/prompt fixtures.
- `tests/auto-reviewer.test.ts`: reviewer retry and parser integration.
- `tests/register.test.ts`: exact-action `/approve` integration.
- `tests/permissions.test.ts`: shell syntax and static-risk regression tests.
- `tests/git-metadata.test.ts`: direct Git metadata ownership tests.
- `tests/default-mode.test.ts`: policy integration and write-root/network-host
  outcomes.
- `docs/research/2026-07-30-codex-approve-for-me-alignment.md`: pinned parity
  evidence and remaining intentional differences.

---

### Task 1: Align Guardian Prompt, Parser, and Exact Retry Context

**Files:**

- Modify: `src/auto-review-request.ts`
- Modify: `src/auto-reviewer.ts`
- Modify: `src/register.ts`
- Modify: `tests/auto-review-request.test.ts`
- Modify: `tests/auto-reviewer.test.ts`
- Modify: `tests/register.test.ts`

**Interfaces:**

- Consumes:
  `AutoReviewApprovalOverride { denialId: string; actionFingerprint: string }`
  from the existing exact-action ledger.
- Produces:
  `parseAutoReviewResult(text: string): AutoReviewResult`.
- Produces:
  `renderAutoReviewPrompt(request: AutoReviewRequest): string`, with
  `trustedDeveloperMessages` containing any exact post-denial approval marker.
- Preserves:
  `AutoReviewRequest.approvalOverride` as trusted internal data until prompt
  rendering; it must never appear inside `untrustedAction`.

- [ ] **Step 1: Replace policy-enforcement tests with pinned Codex parser fixtures**

  In `tests/auto-review-request.test.ts`, remove expectations that a
  structurally valid high/critical allow is rejected by the parser. Add these
  behavior tests:

  ```ts
  it.each([
    [
      "allow",
      { outcome: "allow" },
      {
        decision: "approve",
        risk: "low",
        userAuthorization: "unknown",
        rationale: "Auto-review returned a low-risk allow decision.",
      },
    ],
    [
      "deny",
      { outcome: "deny" },
      {
        decision: "deny",
        risk: "high",
        userAuthorization: "unknown",
        rationale: "Auto-review returned a deny decision without a rationale.",
      },
    ],
  ])("applies Codex defaults to a minimal %s payload", (_name, payload, expected) => {
    expect(parseAutoReviewResult(JSON.stringify(payload))).toEqual(expected);
  });

  it("recovers one JSON object wrapped in surrounding prose", () => {
    expect(
      parseAutoReviewResult(
        'assessment follows: {"outcome":"allow","risk_level":"medium"} done',
      ),
    ).toMatchObject({ decision: "approve", risk: "medium" });
  });

  it.each([
    {
      outcome: "allow",
      risk_level: "high",
      user_authorization: "unknown",
      rationale: "Policy selected allow.",
    },
    {
      outcome: "allow",
      risk_level: "critical",
      user_authorization: "low",
      rationale: "Policy selected allow.",
    },
  ])("leaves policy consistency to Guardian for $risk_level", (payload) => {
    expect(parseAutoReviewResult(JSON.stringify(payload))).toMatchObject({
      decision: "approve",
      risk: payload.risk_level,
    });
  });
  ```

  Keep invalid JSON, invalid enum, missing outcome, non-object, and blank
  rationale tests. Add a compatibility fixture showing that an extra field is
  ignored by the recovery parser, matching Rust `serde` payload behavior:

  ```ts
  expect(
    parseAutoReviewResult('{"outcome":"allow","future_field":true}'),
  ).toMatchObject({ decision: "approve" });
  ```

- [ ] **Step 2: Add exact developer-context approval tests**

  Replace the `trustedApprovalOverride` expectation in
  `tests/auto-review-request.test.ts` with:

  ```ts
  const data = JSON.parse(renderAutoReviewPrompt(request));
  expect(data.trustedDeveloperMessages).toEqual([
    expect.stringMatching(
      /^The user has manually approved a specific action that was previously `Rejected`\./,
    ),
  ]);
  expect(data.trustedDeveloperMessages[0]).toContain(
    '"command":"git push origin main"',
  );
  expect(data.untrustedAction).not.toHaveProperty("approvalOverride");
  ```

  In `tests/register.test.ts`, keep the existing exact fingerprint,
  single-consumption, and non-matching-action assertions. Change the
  `/approve` sent message assertion so its first line must be:

  ```text
  The user has manually approved a specific action that was previously `Rejected`.
  ```

  In `tests/auto-reviewer.test.ts`, add a high-risk allow response without an
  override and assert the reviewer returns it instead of retrying a parse
  failure.

- [ ] **Step 3: Run the Guardian tests and verify RED**

  Run:

  ```sh
  npx vitest --run \
    tests/auto-review-request.test.ts \
    tests/auto-reviewer.test.ts \
    tests/register.test.ts
  ```

  Expected failures:

  - surrounding prose reports `expected strict JSON`;
  - high/critical allow reports `policy-inconsistent`;
  - prompt contains `trustedApprovalOverride` instead of the developer marker;
  - `/approve` message begins with the old Pi-specific wording.

- [ ] **Step 4: Implement the pinned Codex parser**

  In `src/auto-review-request.ts`, remove the optional
  `approvalOverride` argument from `parseAutoReviewResult`. Add a small payload
  decoder:

  ```ts
  function parseAssessmentPayload(text: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) {
        throw new Error("Invalid reviewer output: expected JSON");
      }
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        throw new Error("Invalid reviewer output: expected JSON");
      }
    }
    if (!isRecord(parsed)) {
      throw new Error("Invalid reviewer output: expected an object");
    }
    return parsed;
  }
  ```

  Continue validating `outcome`, `risk_level`, `user_authorization`, and
  `rationale`. Remove:

  - the `allowedKeys` rejection;
  - high-risk authorization enforcement;
  - critical-risk override enforcement.

  Preserve the existing Codex fallback values and rationale strings.

  In `src/auto-reviewer.ts`, call:

  ```ts
  const result = parseAutoReviewResult(text);
  ```

  Fix the existing non-null assertions in `boundedTrustedMessages` by
  destructuring the first message and returning early when absent:

  ```ts
  const [first, ...newer] = messages;
  if (!first) return [];
  let remaining = MAX_TRANSCRIPT_CHARACTERS - first.length;
  // Select bounded entries from `newer`, then return `[first, ...]`.
  ```

- [ ] **Step 5: Align policy pin and exact approval framing**

  In `src/auto-review-request.ts`:

  - change the source pin comment from `bb1af2...` to
    `789c72dcf62d7439863d4d2846454f05b3d51db6`;
  - synchronize the policy template/default policy/output contract with the
    normative files named in the spec;
  - remove the Pi-only `trustedApprovalOverride` instruction;
  - retain Pi naming only where it does not alter policy meaning.

  Render trusted approval context with:

  ```ts
  const AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX =
    "The user has manually approved a specific action that was previously `Rejected`.";

  function approvedActionContext(serializedAction: string): string {
    return [
      AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX,
      "",
      "Approved action:",
      serializedAction,
    ].join("\n");
  }
  ```

  `renderAutoReviewPrompt` must emit:

  ```ts
  {
    trustedUserMessages: userMessages,
    trustedDeveloperMessages:
      approvalOverride === undefined
        ? []
        : [approvedActionContext(serializeAction(action))],
    untrustedAction: action,
    outputSchema: {
      risk_level: ["low", "medium", "high", "critical"],
      user_authorization: ["unknown", "low", "medium", "high"],
      outcome: ["allow", "deny"],
      rationale: "string",
    },
  }
  ```

  Update `/approve` in `src/register.ts` to use the same exported prefix for
  the displayed retry message while preserving exact tool, input, cwd,
  previous rationale, and `triggerTurn: true`.

- [ ] **Step 6: Verify Guardian GREEN and strict formatting**

  Run:

  ```sh
  npx vitest --run \
    tests/auto-review-request.test.ts \
    tests/auto-reviewer.test.ts \
    tests/register.test.ts
  npm run check
  biome check --write \
    src/auto-review-request.ts \
    src/auto-reviewer.ts \
    src/register.ts \
    tests/auto-review-request.test.ts \
    tests/auto-reviewer.test.ts \
    tests/register.test.ts
  biome check --error-on-warnings \
    src/auto-review-request.ts \
    src/auto-reviewer.ts \
    src/register.ts \
    tests/auto-review-request.test.ts \
    tests/auto-reviewer.test.ts \
    tests/register.test.ts
  ```

  Expected: all commands exit zero.

- [ ] **Step 7: Commit only Guardian-owned hunks**

  Stage the four Guardian dirty files plus the exact new hunks in
  `src/register.ts` and `tests/register.test.ts`:

  ```sh
  git add src/auto-review-request.ts src/auto-reviewer.ts \
    tests/auto-review-request.test.ts tests/auto-reviewer.test.ts
  git add -p src/register.ts tests/register.test.ts
  git diff --cached --check
  git diff --cached --stat
  git commit -m "fix: align Guardian assessment parsing with Codex"
  ```

  Before committing, verify the cached diff contains no Git metadata or shell
  scanner hunks.

---

### Task 2: Classify Shell Syntax and Git-Mutation Eligibility Precisely

**Files:**

- Modify: `src/permissions/risk.ts`
- Modify: `tests/permissions.test.ts`
- Modify with hunk staging: `src/default-mode.ts`
- Modify with hunk staging: `tests/default-mode.test.ts`

**Interfaces:**

- Preserves:
  `PermissionRequest.commandSegments?: CommandSegment[]`.
- Produces:
  `shellCommandUsesGitMutation(command: string): boolean`.
- Produces:
  `shellCommandCanGrantGitMetadata(command: string): boolean`.
- `shellCommandCanGrantGitMetadata` returns true only for one direct,
  mutation-bearing segment with no active redirect, substitution, or nested
  shell.

- [ ] **Step 1: Add false-positive and real nested-shell tests**

  In `tests/default-mode.test.ts`, extend the Git metadata grant test:

  ```ts
  for (const command of [
    'git commit -m "document bash support"',
    "git add docs/fish.md",
  ]) {
    await expect(
      evaluateDefaultRequest("bash", { command }, cwd, config()),
    ).resolves.toMatchObject({
      action: "prompt",
      filesystemWriteRoots: [gitRoot],
    });
  }
  ```

  Add these commands to the compound-effects block table:

  ```ts
  [
    'bash -c "git add README.md"',
    'fish -c "git add README.md"',
    'git add "$(printf README.md)"',
    "git add README.md | tee result.txt",
  ]
  ```

  In `tests/permissions.test.ts`, add:

  ```ts
  it.each([
    ['git commit -m "document bash support"', true],
    ["git add docs/fish.md", true],
    ['bash -c "git add README.md"', false],
    ['git add "$(printf README.md)"', false],
    ["git add README.md > result.txt", false],
  ] as const)("decides Git metadata eligibility for %s", (command, expected) => {
    expect(shellCommandCanGrantGitMetadata(command)).toBe(expected);
  });
  ```

  Import `shellCommandCanGrantGitMetadata` explicitly.

- [ ] **Step 2: Run focused tests and verify RED**

  Run:

  ```sh
  npx vitest --run tests/permissions.test.ts tests/default-mode.test.ts
  ```

  Expected: the two ordinary arguments containing `bash` or `fish` are
  incorrectly rejected by the current source-wide regex.

- [ ] **Step 3: Implement one quote-aware syntax scanner**

  In `src/permissions/risk.ts`, replace
  `hasExecutableShellSubstitution` and `hasActiveShellRedirect` with one
  scanner:

  ```ts
  interface ShellSyntax {
    hasExecutableSubstitution: boolean;
    hasActiveRedirect: boolean;
  }

  function scanShellSyntax(source: string): ShellSyntax {
    let quote: "'" | '"' | undefined;
    let escaped = false;
    let hasExecutableSubstitution = false;
    let hasActiveRedirect = false;

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && quote !== "'") {
        escaped = true;
        continue;
      }
      if (quote === "'") {
        if (character === "'") quote = undefined;
        continue;
      }
      if (character === "'") {
        quote = "'";
        continue;
      }
      if (character === '"') {
        quote = quote === '"' ? undefined : '"';
        continue;
      }
      if (
        character === "`" ||
        (character === "$" && source[index + 1] === "(")
      ) {
        hasExecutableSubstitution = true;
      }
      if (quote === undefined && (character === "<" || character === ">")) {
        hasActiveRedirect = true;
      }
    }

    return { hasExecutableSubstitution, hasActiveRedirect };
  }
  ```

  In `parseCommandSegment`, compute whether the parsed executable is a shell
  and whether its own arguments contain a supported command-evaluation flag:

  ```ts
  const commandIndex = args.findIndex(
    (arg) => arg === "--command" || /^-[a-z]*c[a-z]*$/i.test(arg),
  );
  const nestedShell = shellExecutables.has(executable) && commandIndex >= 0;
  ```

  Ordinary argument text must not affect `nestedShell`.

  Avoid non-null assertions in `shellCommandCanGrantGitMetadata`:

  ```ts
  const segments = parseCommandSegments(command);
  const segment = segments.length === 1 ? segments[0] : undefined;
  return Boolean(
    segment &&
      segmentUsesGitMutation(segment) &&
      !segment.hasRedirect &&
      !segment.hasSubstitution &&
      !segment.nestedShell,
  );
  ```

- [ ] **Step 4: Keep the Default Git grant fail closed**

  Preserve the uncommitted `evaluateDefaultRequest` branch:

  ```ts
  if (
    usesGitMutation &&
    command &&
    !shellCommandCanGrantGitMetadata(command)
  ) {
    return {
      action: "block",
      risk: "HARD",
      reason: "Git metadata access requires a single Git mutation command",
    };
  }
  ```

  Do not stage the repository ownership helper functions yet; those belong to
  Task 3.

- [ ] **Step 5: Verify shell/Git GREEN and strict formatting**

  Run:

  ```sh
  npx vitest --run tests/permissions.test.ts tests/default-mode.test.ts
  npm run check
  biome check --write \
    src/permissions/risk.ts \
    tests/permissions.test.ts
  biome check --error-on-warnings \
    src/permissions/risk.ts \
    tests/permissions.test.ts
  ```

  Expected: focused tests, TypeScript, and Biome pass.

- [ ] **Step 6: Commit only scanner and eligibility hunks**

  Use hunk staging because `default-mode.ts` and its tests still contain Task
  3 ownership work:

  ```sh
  git add src/permissions/risk.ts tests/permissions.test.ts
  git add -p src/default-mode.ts tests/default-mode.test.ts
  git diff --cached --check
  git diff --cached
  git commit -m "fix: classify nested shell execution precisely"
  ```

  The cached diff must contain the single-command eligibility branch and its
  integration tests, but no `.git` ownership helper implementation.

---

### Task 3: Extract and Validate Git Metadata Ownership

**Files:**

- Create: `src/git-metadata.ts`
- Create: `tests/git-metadata.test.ts`
- Modify: `src/default-mode.ts`
- Modify: `tests/default-mode.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export type GitMetadataResult =
    | { ok: true; configPath: string; writeRoots: string[] }
    | { ok: false; reason: string };

  export function inspectRepositoryGitMetadata(
    cwd: string,
  ): Promise<GitMetadataResult>;

  export function readRepositoryRemoteHosts(
    configPath: string | undefined,
  ): Promise<string[]>;
  ```

- Consumes:
  `extractShellNetworkHosts` or the existing host normalization logic for
  remote URLs without modifying the remote.
- `default-mode.ts` remains responsible for deciding when inspection is
  needed and how the returned roots/hosts affect `DefaultDecision`.

- [ ] **Step 1: Add direct module tests before creating the module**

  Create `tests/git-metadata.test.ts` importing the wished-for API. Include a
  fixture helper that creates a minimal valid Git directory:

  ```ts
  async function createGitDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(path, "config"), "");
    await mkdir(join(path, "objects"));
    await mkdir(join(path, "refs"));
  }
  ```

  Add one test per ownership boundary:

  - ordinary `.git` directory returns its real path;
  - `.git` symlink is rejected;
  - a `gitdir:` pointer to `/` is rejected;
  - unrelated pointer without back-pointer or valid `core.worktree` is
    rejected;
  - linked worktree with matching `gitdir` and valid `commondir` returns both
    per-worktree and common roots;
  - linked worktree with malformed/missing common structure is rejected;
  - submodule pointer with valid quoted `core.worktree` returns its metadata
    root;
  - submodule pointer whose `core.worktree` resolves elsewhere is rejected;
  - SSH remote `git@github.com:owner/repo.git` returns `github.com`;
  - HTTPS and `ssh://` remotes are parsed without rewriting the config.

- [ ] **Step 2: Run the new module tests and verify RED**

  Run:

  ```sh
  npx vitest --run tests/git-metadata.test.ts
  ```

  Expected: module resolution fails because `src/git-metadata.ts` does not yet
  exist.

- [ ] **Step 3: Implement the focused Git metadata module**

  Move and refine these uncommitted helpers from `src/default-mode.ts`:

  - `isFilesystemRoot`;
  - `hasGitDirectoryStructure`;
  - `coreWorktree`;
  - `worktreeGitDirectoryPointsBack`;
  - `submoduleGitDirectoryBelongsToWorktree`;
  - `repositoryGitMetadata`;
  - `repositoryRemoteHosts`.

  Rename the public functions to the interfaces above. Keep helpers private.
  Use `lstat` for `.git` so symbolic links are rejected before `realpath`.

  Every successful result must use resolved paths and deduplicate roots:

  ```ts
  return {
    ok: true,
    configPath: join(commonDirectory, "config"),
    writeRoots: [...new Set([gitDirectory, commonDirectory])],
  };
  ```

  Every malformed, missing, root-level, or ownership-mismatched structure must
  return `{ ok: false, reason }`; do not throw filesystem errors through the
  policy boundary.

- [ ] **Step 4: Integrate the module into Default policy**

  In `src/default-mode.ts`:

  - delete the moved filesystem/Git helper implementations;
  - import `inspectRepositoryGitMetadata` and
    `readRepositoryRemoteHosts`;
  - call inspection only for implicit Git network or Git mutation requests;
  - retain the HARD block for a failed ownership result;
  - retain verified metadata roots only for direct eligible Git mutations;
  - retain inferred remote hosts for Git network operations.

  Update `tests/default-mode.test.ts` fixtures so every ordinary repository
  used for a successful grant has `HEAD`, `config`, `objects`, and `refs`.
  Keep integration assertions about `DefaultDecision`; move structural detail
  assertions into `tests/git-metadata.test.ts`.

- [ ] **Step 5: Verify Git ownership GREEN**

  Run:

  ```sh
  npx vitest --run \
    tests/git-metadata.test.ts \
    tests/default-mode.test.ts \
    tests/permissions.test.ts
  npm run check
  biome check --write \
    src/git-metadata.ts \
    src/default-mode.ts \
    tests/git-metadata.test.ts \
    tests/default-mode.test.ts
  biome check --error-on-warnings \
    src/git-metadata.ts \
    src/default-mode.ts \
    tests/git-metadata.test.ts \
    tests/default-mode.test.ts
  ```

  Expected: all commands exit zero.

- [ ] **Step 6: Commit the ownership module**

  ```sh
  git add src/git-metadata.ts src/default-mode.ts \
    tests/git-metadata.test.ts tests/default-mode.test.ts
  git diff --cached --check
  git diff --cached --stat
  git commit -m "fix: validate Git metadata ownership"
  ```

  Confirm the cached diff contains no Guardian prompt/parser changes.

---

### Task 4: Record Parity, Run Full Gates, and Close the Dirty Tree

**Files:**

- Modify:
  `docs/superpowers/specs/2026-07-31-guardian-and-default-hardening-design.md`
- Modify:
  `docs/research/2026-07-30-codex-approve-for-me-alignment.md`

**Interfaces:**

- Produces a documented upstream pin and an explicit table of aligned versus
  intentionally Pi-specific behavior.
- Produces no runtime behavior.

- [ ] **Step 1: Update research evidence**

  In `docs/research/2026-07-30-codex-approve-for-me-alignment.md`:

  - update the inspected Codex SHA to
    `789c72dcf62d7439863d4d2846454f05b3d51db6`;
  - record that parser validation is structural and policy remains in the
    Guardian prompt;
  - record the exact post-denial developer marker;
  - distinguish Pi deterministic Git/shell hardening from Guardian parity;
  - retain the known non-goals: reusable Codex child-session manager,
    Guardian lifecycle events/telemetry, and identical review sandbox
    internals.

  Change the design spec status from `Approved` to `Implemented` only after all
  runtime gates pass.

- [ ] **Step 2: Run focused feature tests**

  Run:

  ```sh
  npx vitest --run \
    tests/auto-review-request.test.ts \
    tests/auto-reviewer.test.ts \
    tests/register.test.ts \
    tests/permissions.test.ts \
    tests/git-metadata.test.ts \
    tests/default-mode.test.ts
  ```

  Expected: all focused tests pass.

- [ ] **Step 3: Run TypeScript and strict Biome**

  Run:

  ```sh
  npm run check
  biome check --error-on-warnings \
    src/auto-review-request.ts \
    src/auto-reviewer.ts \
    src/register.ts \
    src/permissions/risk.ts \
    src/git-metadata.ts \
    src/default-mode.ts \
    tests/auto-review-request.test.ts \
    tests/auto-reviewer.test.ts \
    tests/register.test.ts \
    tests/permissions.test.ts \
    tests/git-metadata.test.ts \
    tests/default-mode.test.ts
  ```

  Expected: both commands exit zero with no warnings.

- [ ] **Step 4: Run the complete suite**

  Run:

  ```sh
  npm test
  ```

  Expected: all normal tests pass. The opt-in external Homebrew core regression
  may remain skipped here because it is verified separately.

  If the outer sandbox reports `listen EPERM 127.0.0.1`, rerun the exact
  command with local loopback permission. Do not treat that environment error
  as a product failure.

- [ ] **Step 5: Reverify YOLO bypass and core gate**

  Run:

  ```sh
  npm run core:check
  npm run core:test
  npx vitest --run tests/register.test.ts -t "YOLO"
  ```

  Expected:

  - installed core hash/capability verifies;
  - abort-ignorant prepared tool regression passes;
  - YOLO tests show no risk evaluator, Guardian, human approval, or sandbox
    execution before native tool execution.

- [ ] **Step 6: Audit the working tree**

  Run:

  ```sh
  git diff --check
  git status --short
  git diff HEAD -- \
    src/auto-review-request.ts \
    src/auto-reviewer.ts \
    src/default-mode.ts \
    src/permissions/risk.ts \
    tests/auto-review-request.test.ts \
    tests/auto-reviewer.test.ts \
    tests/default-mode.test.ts \
    tests/permissions.test.ts
  ```

  Expected:

  - the original eight dirty files have no remaining unstaged changes;
  - only the research/spec documentation remains for the docs commit;
  - no unrelated file is staged or overwritten.

- [ ] **Step 7: Commit documentation**

  ```sh
  git add -f \
    docs/superpowers/specs/2026-07-31-guardian-and-default-hardening-design.md \
    docs/research/2026-07-30-codex-approve-for-me-alignment.md
  git diff --cached --check
  git diff --cached
  git commit -m "docs: record Codex Guardian alignment"
  ```

- [ ] **Step 8: Request final whole-feature review**

  Review the range from the commit immediately before Task 1 through Task 4.
  The reviewer must check:

  - parser behavior against Codex `789c72d`;
  - exact-action post-denial approval binding;
  - false-positive and false-negative shell syntax cases;
  - Git ownership validation and fail-closed paths;
  - SSH remote preservation;
  - YOLO bypass and Default/Auto separation;
  - strict test evidence and atomic commit boundaries.

  Fix Critical and Important findings before declaring completion. Record
  accepted Minor findings explicitly.
