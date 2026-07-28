# Codex Guardian Prompt Alignment Design

## Goal

Replace the abbreviated Auto reviewer policy with the English Codex Guardian
policy embedded directly in TypeScript, and align reviewer output parsing with
Codex's structured assessment contract.

## Source and attribution

The copied policy comes from `openai/codex` at commit
`bb1af235ea2822d7a40f75ef52e4d6a2cde84da2`:

- `codex-rs/core/src/guardian/policy_template.md`
- `codex-rs/core/src/guardian/policy.md`
- `codex-rs/core/src/guardian/prompt.rs`

The upstream repository is Apache-2.0 licensed. The TypeScript source will
retain an English attribution comment with the upstream commit and paths.

## Prompt representation

`src/auto-review-request.ts` will contain:

- `CODEX_GUARDIAN_POLICY_TEMPLATE`
- `CODEX_GUARDIAN_DEFAULT_POLICY`
- `CODEX_GUARDIAN_OUTPUT_CONTRACT`
- `AUTO_REVIEW_SYSTEM_PROMPT`, built by replacing
  `{{ tenant_policy_config }}` and appending the output contract

No runtime network fetch, separate prompt file, localization, or Chinese prompt
text will be introduced.

## Output contract

The reviewer-facing schema becomes:

```json
{
  "risk_level": "low | medium | high | critical",
  "user_authorization": "unknown | low | medium | high",
  "outcome": "allow | deny",
  "rationale": "string"
}
```

Only `outcome` is required, matching Codex. Missing values receive Codex-style
defaults:

- allow: `risk_level = low`
- deny: `risk_level = high`
- `user_authorization = unknown`
- a non-empty deterministic fallback rationale

Unknown fields, invalid enum values, non-object JSON, and non-JSON output remain
parse failures.

The internal policy result continues to expose `decision: approve | deny` so
the existing capability and sandbox execution pipeline does not change.

## Preserved Pi boundaries

- Deterministic Default-mode blocks never reach the model.
- Model approval remains bound to one exact tool call.
- Sandbox enforcement and execution-time revalidation remain authoritative.
- Reviewer calls remain tool-free, stateless, bounded, cancellable, and
  retry-free.
- Reviewer failure keeps the current UI fallback and headless fail-closed
  behavior.
- The existing trusted-user-message envelope remains in place; tool arguments
  remain untrusted action data.

## Tests

Tests will establish the new contract before production changes:

- accept a full Codex assessment;
- accept `{"outcome":"allow"}` and apply defaults;
- map `allow/deny` to `approve/deny`;
- reject unknown fields and invalid enum values;
- verify the reviewer client sends the embedded Codex policy;
- update registration fixtures to use the compatible internal result type;
- run the complete Vitest suite and TypeScript checking.

