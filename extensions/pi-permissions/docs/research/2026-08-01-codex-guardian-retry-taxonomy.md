# Codex Guardian Retry Taxonomy Research

**Date:** 2026-08-01

**Scope:** Compare the current Pi Guardian retry classifier with the current
`openai/codex` Guardian retry boundary. Model selection is intentionally out of
scope: Pi keeps its current active/default model and configured `reviewer`
fallback behavior.

## Sources

- Pi implementation: `src/auto-reviewer.ts`, especially
  `isTransientProviderFailure()` and `PiAutoReviewer.review()`.
- Pi tests: `tests/auto-reviewer.test.ts`.
- Codex current Guardian retry loop and classifier:
  [`codex-rs/core/src/guardian/review.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review.rs).
- Codex retry backoff:
  [`codex-rs/core/src/util.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/util.rs).
- Codex exposed error taxonomy:
  [`codex-rs/protocol/src/protocol.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs).

The local Codex checkout used for source confirmation is at commit
`53d06e24ea318a963812030fa8fed1bd0fc42d42`.

## Codex behavior

Codex represents review failures as `PromptBuild`, `Session`, `Parse`,
`Timeout`, or `Cancelled`. A `Session` failure may carry structured
`CodexErrorInfo`.

`should_retry_guardian_review()` returns true only for:

1. `Session` with `ServerOverloaded`;
2. `Session` with `HttpConnectionFailed`;
3. `Session` with `ResponseStreamConnectionFailed`;
4. `Session` with `InternalServerError`;
5. `Session` with `ResponseStreamDisconnected`;
6. `Parse` errors.

It does not retry prompt-build failures, untyped session failures, bad
requests, unauthorized errors, timeouts, or cancellations. The review still
uses one aggregate 90-second deadline and at most three attempts. The selected
model/session is retained across those attempts.

Codex's shared backoff starts at 200 ms, doubles per attempt, and applies
0.9–1.1 jitter. Pi currently uses a deterministic 250/500/1000 ms capped
backoff. P2-2 does not change backoff timing; timing parity is a separate,
lower-value follow-up.

## Pi behavior

Pi already has the correct outer lifecycle:

- `GUARDIAN_REVIEW_TIMEOUT_MS` is 90 seconds;
- `GUARDIAN_REVIEW_MAX_ATTEMPTS` is 3;
- `complete()` is called with `maxRetries: 0`, so the extension owns retries;
- parse errors retry;
- caller cancellation and aggregate timeout fail closed without another call;
- the selected model and Guardian session remain fixed across attempts.

The mismatch is `isTransientProviderFailure()`:

- it treats status `500`, `502`, `503`, and `504` as retryable;
- it treats a broad list of transport codes as retryable;
- it also treats broad message fragments such as `overload`, `service unavailable`,
  `fetch failed`, and `connection reset` as retryable;
- it traverses nested `cause` values and safely handles cycles;
- when any status is present, all observed statuses must be retryable, which is
  a useful conservative rule and should be preserved.

This heuristic can be broader than Codex when an arbitrary provider message
contains a transient-looking phrase without a structured transport/session
failure. It can also miss a provider-specific stream-disconnect shape if that
shape exposes neither a recognized code nor a recognized message.

## Alignment decision

P2-2 should align retry *eligibility*, not copy Codex Rust error types into the
Pi extension:

- keep the Pi provider API and `AutoReviewerFailure` public kinds;
- classify known provider error shapes into the five Codex-like retryable
  transport/server categories;
- keep parse errors retryable;
- keep prompt/session errors without a recognized transient signal,
  authorization/client errors, timeout, and cancellation non-retryable;
- keep the existing 90-second deadline, three-attempt cap, fixed selected model,
  and deterministic backoff;
- fail closed on unknown errors rather than widening retry behavior.

The primary regression surface is `PiAutoReviewer.review()`, not a private
classifier test. The test matrix should cover each Codex-positive category,
each important non-retry category, nested causes, malformed output, deadline,
cancellation, and the invariant that no retry occurs after a non-transient
error.

## Explicit non-goals

- Do not add Codex catalog model override or provider preferred review-model
  selection; the current Pi default/active model and configured reviewer
  fallback are the product decision.
- Do not change Guardian policy, model resolution, prompt/session lifecycle,
  app-server telemetry, proxy lifecycle, or sandbox permissions.
- Do not expose retry limits, classifier sets, or backoff parameters in
  `config.json`.
