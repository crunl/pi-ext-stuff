# G3 evidence audit — Approve for me (2026-09-10)

**Standing Codex pin:** `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`  
**Pi tree:** working tree under `extensions/pi-permissions` (uncommitted changes are the fact)  
**Host:** `@earendil-works/pi-coding-agent@0.85.1`  
**Sandbox:** `@anthropic-ai/sandbox-runtime@0.0.74`

## Scope

This audit does **not** claim delivery. It records what current tests and
source actually prove, what is hermetic-only, and what remains native-only.
Host API limits are in `docs/host-api-boundaries.md`.

## Suite evidence (this run)

| Check | Result |
| --- | --- |
| `npm run check` (`tsc --noEmit`) | clean |
| `npm test` (vitest --run) | **37 files, 1079 passed / 1 skipped** |
| Biome on markdown docs | N/A (docs ignored by biome config) |

## Claim → evidence boundary

| # | Claim | Level | Evidence | Does not prove |
| --- | --- | --- | --- | --- |
| R1 | Auto routes eligible reviews to Guardian, not a human popup | **Proven (hermetic)** | `src/permission-copy.ts` labels; `src/register.ts` Auto path; `tests/auto-reviewer.test.ts`; `tests/register.test.ts` production `PiAutoReviewer` freeze-A/grant-B | Live provider latency/TLS; human never seeing any UI notice |
| R2 | Approval may satisfy the review gate only; hard deny is not unlockable by ordinary grant | **Proven (hermetic)** | `tests/approve-for-me-engine.test.ts` “preserves hard deny rules while applying an approved one-shot grant”; engine deny paths | That every possible deny rule is exhaustively covered |
| R3 | Running attempt A is not retroactively expanded by a later turn grant | **Proven (hermetic)** | `tests/register.test.ts` “freezes attempt authority after initial review…”; “freezes A and grants B through production PiAutoReviewer…” | Native multi-process concurrent spawn races beyond fixtures |
| R4 | New attempt B is a new invocation, not an automatic Bash replay | **Proven (hermetic)** | Engine “does not replay a reviewed command after a mid-execution network denial”; register boundary tests “without replaying the command”; Bash never auto-replays | Kernel-level guarantee that no OS side effect is re-run by some other layer |
| R5 | Turn grants expire at turn end; no session grant | **Proven (hermetic)** | `tests/register.test.ts` “keeps request_permissions grants within the current turn”; Engine `expires: "turn-end"` | Cross-process persistence (by design absent) |
| R6 | Circuit breaker interrupts after consecutive/window denials | **Proven (hermetic)** | `tests/approve-for-me-engine.test.ts` three denials / window cases; `tests/register.test.ts` abort-on-circuit | That production model denials match fixture denial rates |
| R7 | Guardian worker lifecycle: no signal after exit, no replace without close, cooperative retirement | **Proven (hermetic + source fixture)** | `tests/guardian-worker.test.ts` G1 cases (post-exit signal, replace-without-close, cooperative retirement, async failure before close) | Full native descendant tree under every OS/SRT combination |
| R8 | Escalated Bash is one-shot, exact command/cwd, not sandbox-enforced | **Proven (hermetic)** | `tests/register.test.ts` escalated once-then-sandboxed; `tests/pi-approve-for-me-adapters.test.ts` escalated mapping | That every escalated binary cannot touch denyRead paths (open gap; see §Open) |
| R9 | Host-admission tools are review-only (`sandboxEnforcesAction=false`) | **Proven (hermetic)** | `tests/register.test.ts` “reviews a generic host tool without claiming sandbox enforcement”; adapters | MCP/custom tool side effects under host authority |
| R10 | Explicit network: restricted → grant → later direct/proxy only for new attempts | **Mostly hermetic** | `tests/register.test.ts` restricted/direct/whole-network cases; `tests/srt-network-mode-patch.test.ts` | **Native** physical offline, TLS/system helper, real connect-guard tickets |

## Deliberate non-claims

Do **not** treat any of the following as delivered by the 1079-test suite:

- Kernel / Seatbelt / SRT native proof on every platform
- TLS `strict` vs `system` success or helper isolation
- Launch-protocol native pilot (historical v4 failed; not re-run here)
- “Approve for me is production-ready” as a product sign-off

## Open items (still out of this audit’s proof)

1. **Escalated vs denyRead** — Codex suppresses unsandboxed execution when denied reads exist (`sandboxing.rs`). Pi has delegation/ceiling checks, not the same automatic suppression. Candidate P1.
2. **auto still allows human-blocking question tools** — host has no built-in question tool; extension policy may still allow custom/question to block on humans. Candidate P1.
3. **Dangerous-command blacklist vs Guardian** — static list still overlaps Guardian judgment (P2).
4. **Native acceptance gates** — any claim of “real offline / real TLS / real kernel isolation” needs a separate, explicitly authorized native plan.

## Conclusion for G3

- Hermetic Approve-for-me semantics (R1–R9) are **supported by the current suite**.
- R10 network claims are **policy/hermetic**, not native isolation proof.
- **Do not close the goal as delivered** on this audit alone; G3 is a boundary map, not a ship gate.
- Next code work, if any, should stay on the P1 list (auto human-block tools; escalated denyRead) rather than expanding design surface.
