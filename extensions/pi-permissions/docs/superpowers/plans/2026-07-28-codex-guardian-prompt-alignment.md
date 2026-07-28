# Codex Guardian Prompt Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed the English Codex Guardian policy directly in the Auto reviewer and consume its structured assessment contract.

**Architecture:** `auto-review-request.ts` remains the sole prompt and parsing boundary. It will embed the attributed Codex policy, translate Codex assessment fields into the existing internal approve/deny result, and leave `auto-reviewer.ts`, capability binding, fallback, and sandbox execution structurally unchanged.

**Tech Stack:** TypeScript 5.9, Vitest 4, `@earendil-works/pi-ai` 0.82.1.

## Global Constraints

- All prompt and new code-facing text is English.
- Copy from `openai/codex` commit `bb1af235ea2822d7a40f75ef52e4d6a2cde84da2`.
- Preserve deterministic blocks, one-call capabilities, sandbox revalidation, cancellation, and fallback behavior.
- Use strict TDD: observe focused tests fail before production edits.

---

### Task 1: Establish the Codex assessment contract

**Files:**
- Modify: `tests/auto-review-request.test.ts`
- Modify: `src/auto-review-request.ts`
- Modify: `tests/auto-policy.test.ts`

**Interfaces:**
- Produces: `AutoReviewRisk`, `AutoReviewUserAuthorization`,
  `AutoReviewResult`.
- Produces: `parseAutoReviewResult(text: string): AutoReviewResult`.
- Preserves: `AutoReviewResult.decision: "approve" | "deny"` for
  `reviewAutoPrompt`.

- [ ] **Step 1: Write failing parser tests**

Add literal fixtures asserting:

```ts
expect(parseAutoReviewResult(JSON.stringify({
  risk_level: "medium",
  user_authorization: "high",
  outcome: "allow",
  rationale: "The requested action is authorized and bounded.",
}))).toEqual({
  decision: "approve",
  risk: "medium",
  userAuthorization: "high",
  rationale: "The requested action is authorized and bounded.",
});

expect(parseAutoReviewResult('{"outcome":"allow"}')).toEqual({
  decision: "approve",
  risk: "low",
  userAuthorization: "unknown",
  rationale: "Auto-review returned a low-risk allow decision.",
});
```

Add denial defaults and invalid field/enum cases.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/auto-review-request.test.ts
```

Expected: failures because the parser still expects
`decision/risk/rationale`.

- [ ] **Step 3: Implement the minimal parser and type changes**

Parse only `risk_level`, `user_authorization`, `outcome`, and `rationale`;
require `outcome`; validate optional enum fields; apply Codex defaults; map
`allow` to `approve`.

- [ ] **Step 4: Update policy fixtures and verify GREEN**

Update `tests/auto-policy.test.ts` fixtures to include
`userAuthorization`, then run:

```bash
npx vitest run tests/auto-review-request.test.ts tests/auto-policy.test.ts
```

Expected: both files pass.

- [ ] **Step 5: Commit the contract change**

```bash
git add src/auto-review-request.ts tests/auto-review-request.test.ts tests/auto-policy.test.ts
git commit -m "feat: align auto review assessment contract with Codex"
```

---

### Task 2: Embed the Codex Guardian policy

**Files:**
- Modify: `tests/auto-reviewer.test.ts`
- Modify: `tests/auto-review-request.test.ts`
- Modify: `src/auto-review-request.ts`

**Interfaces:**
- Produces: `AUTO_REVIEW_SYSTEM_PROMPT: string`.
- Consumes: `parseAutoReviewResult` from Task 1.

- [ ] **Step 1: Write failing prompt-consumer tests**

Assert through the reviewer invocation that the system prompt contains the
Codex evidence-handling, authorization-scoring, risk-taxonomy, outcome-policy,
and strict JSON contract sections. Assert that the tenant placeholder is gone.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run tests/auto-reviewer.test.ts tests/auto-review-request.test.ts
```

Expected: failures because the abbreviated policy lacks the Codex sections.

- [ ] **Step 3: Embed and compose the attributed English policy**

Add the three upstream-derived constants and build
`AUTO_REVIEW_SYSTEM_PROMPT` by replacing the tenant policy placeholder and
appending the output contract. Retain the current bounded JSON user envelope.

- [ ] **Step 4: Update reviewer response fixtures**

Return Codex-compatible assessment JSON from the mocked model responses and
assert the translated internal result.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/auto-reviewer.test.ts tests/auto-review-request.test.ts
```

Expected: both files pass.

- [ ] **Step 6: Commit the prompt change**

```bash
git add src/auto-review-request.ts tests/auto-review-request.test.ts tests/auto-reviewer.test.ts
git commit -m "feat: embed Codex guardian policy for auto review"
```

---

### Task 3: Integrate and verify

**Files:**
- Modify: `tests/register.test.ts`
- Modify: any test fixture that constructs `AutoReviewResult`

**Interfaces:**
- Consumes: the translated `AutoReviewResult` from Task 1.
- Preserves: existing registration, denial, fallback, pause, capability, and
  sandbox behavior.

- [ ] **Step 1: Run TypeScript checking to identify stale fixtures**

Run:

```bash
npx tsc --noEmit
```

Expected: failures identify fixtures missing `userAuthorization`.

- [ ] **Step 2: Update only stale assessment fixtures**

Add literal `userAuthorization` values without changing registration
expectations or production policy.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm test
npx tsc --noEmit
git diff --check
```

Expected: 204 or more tests pass, TypeScript exits 0, and diff check is clean.

- [ ] **Step 4: Review the final diff**

Confirm that production changes are limited to the prompt/parser boundary,
that no Chinese text was added to the prompt, and that deterministic/sandbox
paths are unchanged.

- [ ] **Step 5: Commit integration updates**

```bash
git add tests src
git commit -m "test: verify Codex guardian auto review integration"
```

