# Disposition Vocabulary Alignment to Codex (rename, not redesign)

## Scope

- Date: 2026-09-25
- Codex pin (standing): `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- Host pin: `@earendil-works/pi-coding-agent@0.86.0`
- Tree: `extensions/pi-safety` at `18044f0` (rename commit) plus the
  fail-closed gate work that followed it
- Question: after renaming the disposition enum, does any old vocabulary remain
  that can change behaviour, mislead a reader, or outlive the type it was derived
  from?
- Deliverable: **the rename's residue audit and its closure.** This note does not
  re-open the disposition design, does not add a tier, and does not change any
  classification outcome.

### What this note does not claim

- It does not claim the new names are better English. They are Codex's, chosen for
  alignment, and `Skip` is a slightly worse word than "auto-approve" because it
  does not say who skipped.
- It does not claim the static layer is now provably correct. Renaming a value
  proves nothing about the code that produces it. Behaviour changed in separate
  work — closing the disconnected `executableTrusted` gate, reclassifying
  `core.hooksPath`, and the `ext::` hole in `remote.<name>.url` that the gate
  review surfaced — and that work belongs to its own commits, not here.
- It does not claim a green suite is runtime evidence. Every statement below is a
  source-level or hermetic-test claim.

## The rename

`Risk = "LOW" | "REVIEW" | "HARD"` became
`ApprovalDisposition = "Skip" | "NeedsApproval" | "Forbidden"`.

The old names described **severity** while the values described **action**, and
the gap was not cosmetic: `rm -r *` was `LOW`, which is not a claim that it is
harmless, only that the static layer does not stop it. A reader who saw `LOW`
would reasonably infer safety that no code path asserts. The new names are
dispositions, so the same call now reads as what it is.

The names are Codex's, from `ExecApprovalRequirement`. fx was checked and **not**
followed: its `Risk x Decision` pair is an LLM product with no static producer, so
adopting it would have introduced a value nothing can emit.

## Root cause of the residue

The type declaration was the only thing that changed. The old vocabulary had also
propagated into three hand-maintained mirrors, none of which any compiler checks:

1. **A parallel closed vocabulary.** `RESIDUAL_SIGNALS` in
   `src/permissions/residual.ts` is a hand-written `as const` array. It is *not*
   derived from `ApprovalDisposition`, so nothing stopped `risk_not_low` from
   outliving `LOW`. It reached the JSONL metrics stream as
   `record.residual_signals`, so this was the one residue with runtime
   consequence.
2. **Prose.** Comments that describe the current behaviour in the old terms, most
   seriously the header of `src/permissions/risk.ts` itself, which described four
   tiers by the old value names and so contradicted the type declared 40 lines
   below it.
3. **Dated notes.** `2026-09-19-p0-skip-llm-first-principles.md` contains the
   `!== "LOW"` predicate as a code block, presented as the design rather than as a
   record.

The generalisable lesson: a type is only the single source of truth for the
values it *derives*. Any string literal that merely *refers* to one of its values
is a second source, and renaming will desync it silently.

## What was done

- `risk_not_low` -> `risk_not_skip`, across `src/` and `tests/` only. Dated notes
  were deliberately not rewritten; see below.
- Two assertions added in `tests/permissions-residual.test.ts` that tie the tag to
  the value it negates: one pins the tag text, and one checks
  `residualsForPrompt({ risk: ... })` against all three current dispositions. The
  second stops compiling if the vocabulary moves, which is the enforcement that
  was missing. A type-level or codegen solution was rejected: deriving the tag at
  runtime from the disposition would widen `ResidualSignal` to `string` and
  destroy the closed set the metrics consumers rely on.
- The `src/permissions/risk.ts` header now states four tiers and three
  dispositions explicitly, and says why the last two tiers share one: tiers 3 and
  4 reach the same auto-approve decision from opposite evidence, and only tier 3
  asserts that nothing is left to prove.
- A `Vocabulary superseded` annotation was added to the top of the P0 note, in the
  same style as the `Superseded (partial)` block already there. The body is
  unedited.

## Why the dated note body was not rewritten

`AGENTS.md` makes `docs/research/` the design history. A note records what was
decided on its date, and editing `!== "LOW"` to `!== "Skip"` would make a 2026-09-19
record assert something that was not true on 2026-09-19.

The repo's stated remedy is stronger than the one taken here. `AGENTS.md` says to
"retire a note by deleting it and keeping any still-needed assertions in a newer
dated note", and that is not what happened: the note was annotated, not deleted.
The reason is that most of it still holds — the first-principles constraints, the
skip / no-skip split, and the residual taxonomy are all unaffected by the rename —
but that is a judgement about this note, not an argument that deletion is wrong in
general. A reader should treat the annotation as the mitigation, and should know
the project's own rule would have deleted the note.

The residual risk is that a reader lands on the old note and copies the predicate.
The annotation is the mitigation, and it matches the `Superseded (partial)` block
already at the top of that note. It is not a convention this corpus follows
elsewhere: the other two supersessions it contains are prose mentions, and no other
note carries an annotation block.

## Verification

`npm run preflight:sibling`, `npm run check`, `npm run lint`, `npm run test` on
this tree. The residue audit itself was run with `ast-grep` structural queries
rather than text search, because a text search cannot distinguish a value in code
from the same word in a comment, and the earlier hand-written identifier greps had
missed this class entirely:

- string literals equal to any retired value: 0
- any `risk` / `action` / `riskDecision` property assigned a retired value: 0
- identifiers matching the retired vocabulary: 12 distinct symbols (66
  occurrences), all the *review mechanism* (`GUARDIAN_REVIEW_MAX_ATTEMPTS`,
  `REVIEW_STATUS_ICON`, `REVIEW_STATUS_KEY`, …), none a disposition value. `review`
  as a domain concept and `REVIEW` as a disposition were always two different
  things that shared a word.

That audit covered **code values only**, and the zeros should not be read as "the
old vocabulary is gone". Test fixtures and test names still carry it:
`tests/register.test.ts` has `"LOW test operation"` / `"REVIEW test operation"` /
`"HARD test policy"` as human-readable reason strings, and roughly twenty `it()`
names describe behaviour in the old terms. None can change a decision, so they were
left deliberately rather than by oversight — but an audit reporting zero has to
say what it did not look at.

The rename also breaks previously-written metrics. `residual_signals` reaches
`guardian-metrics.jsonl` as a top-level key of each record, and the schema version
did not change, so a query bucketed on `residual_signals == "risk_not_low"` returns
zero rows for every record written after this change and a time series across the
rename splits one bucket into two with no version marker. The new name is right —
the old one named a disposition that no longer exists — but the discontinuity in
already-written data is real and is not migrated.

## Follow-ups not taken

- Program identity is not established for bare command words, so an arbitrary
  binary reached by path or by `hash -p` gets no check. That is not a vocabulary
  question and an earlier draft of this section listed it here; it now lives in
  `2026-09-26-static-git-runtime-config-boundary.md`, which also carries the Git
  runtime-configuration boundary and the reference implementations' answers.
- `.superpowers/` contains the old vocabulary in session-local review artifacts.
  `AGENTS.md` already excludes these from product evidence, so they were left
  alone.
