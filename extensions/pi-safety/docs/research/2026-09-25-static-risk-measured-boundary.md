# Measured boundary of the pi-safety static risk layer

Date: 2026-09-25
Standing upstream pin: `openai/codex` @ `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
Day-of snapshot used for every `fx` citation below: `vercel-labs/fx` @ `759001b3`
(local checkout at `~/.graphify/repos/vercel-labs/fx`).

## Scope

This note records how far the static risk layer was pushed, what it now
guarantees, and where it was measured to stop. It covers the four
`classifyRisk` tiers and the shell/Git/CLI analyses under
`src/permissions/`. It does not cover the Engine, Guardian, or SRT layers, and
it makes no claim about any tool other than the ones named.

## The four rounds that produced the current shape

Round 1 (`fdc3ff6`) closed seven fail-open classes found by comparing the layer
against codex and fx: wrapper bypass, lexical defects, line continuation,
leading redirections, Git nested execution, process control, and external
side-effect CLIs.

Round 2 (`f00aae0`) came from an adversarial review that stopped asking "is the
refactor behaviour-preserving" and started asking "is the behaviour correct".
It found brace and glob expansion in the command word, `git -c include.path`,
and global options hiding a verb.

Round 3 (`728c2e9`) reviewed round 2's own fix and found that its algorithm
was wrong rather than incomplete. That is the part worth recording.

Round 4 (this commit) reviewed round 3 and found two more logic errors, both
introduced *by* the round-3 fix rather than pre-existing. They are recorded here
because the pattern matters more than the two holes: each round's repair created
a new fail-open somewhere adjacent, and only adversarial review caught them.

| Round | Introduced | Caught by |
| --- | --- | --- |
| 2 | dual-reading operand union | round 3 review |
| 3 | unconditional `--help`/`--version` short-circuit | round 4 review |
| 3 | `git config` key read without consuming value options | round 4 review |

## The finding that changed the design

Round 2 fixed "an option's value is mistaken for the verb" by scanning the
operand list twice — once assuming an unknown option takes the next word as its
value, once assuming it does not — and unioning the two readings. It fixed
`terraform --chdir /tmp apply`, and the review correctly found
`terraform --chdir /tmp -lock=false apply` still reaching LOW.

The reason is arithmetic, not an oversight: *N* unknown options admit 2^N
grammars. Two options is four readings. Enumerating readings does not
generalise past the second option, so the shape was wrong.

The replacement stops guessing. An unrecognised option **before any operand has
been read** makes the verb's position unprovable, and the invocation is routed
to review. Once an operand exists, skipping the option without its value leaves
every later operand one place to the right and the verb still in the set: a
shift can introduce a spurious candidate but cannot remove a real one. The
threshold is therefore one operand, not a window.

`invocationHasExternalSideEffect` consequently returns `proved | refuted |
unknown` instead of a boolean, and `unknown` blocks Tier 3 rather than being
folded into "safe". A similar change in `shell-network.ts` treats an unreadable
package-manager grammar as network use, gated by the connection boundary.

## The two errors round 3 introduced

Both were found by the round-4 review and both were fail-opens, which is the
reason they are written down rather than just fixed.

**The terminal-flag short-circuit was unconditional.** `--help` and `--version`
print and exit, so round 3 checked for them anywhere in argv before the grammar
scan. But `gh pr create --title --help --body x` passes `--help` to `--title`
as its value and goes on to create the pull request. A short-circuit that fires
on a token without asking whether the token is a value is the same mistake as
guessing a verb position. The check is now restricted to a position where no
operand precedes it, which is the only place a terminal flag is unambiguous.

**The `git config` key was read without consuming value options.** Round 3
correctly stopped treating every argument as a potential key, and took the first
non-flag one. But `--file` takes a value, so `git config --file user.name
--add core.pager '!cmd'` reads the *file path* as the key, decides `user.name`
is a scalar, and passes a write of `core.pager` as safe. The value-taking
options are now consumed before the key is read, the same rule the CLI operand
scan uses, and `--edit` is gated separately because it opens the file in
`$GIT_EDITOR`.

## The other inversion: Git config keys

The program-key check was a name list (`core.pager`, `credential.helper`, …).
It was inverted to an allowlist of config-key *final segments* whose value is a
setting (`name`, `url`, `quotepath`, …). A key is treated as a program unless
its last dotted segment is a known scalar name.

The reason is the same arithmetic. Git's program-valued namespace includes
`color.pager`, `pager.<cmd>.cmd`, `diff.<driver>.textconv`,
`merge.<driver>.driver`, `gpg.<format>.program`, `remote.<name>.uploadpack`,
`credential.<url>.helper`, and whatever a future release adds. A name list has
to be complete; an allowlist only has to be incomplete in the safe direction.
The URL-scoped credential helper was the concrete miss — it reached the sandbox
as LOW because only the bare `credential.helper` spelling was listed.

`core.hooksPath` remains deliberately safe. It names a directory Git searches
for hook files, not a program it execs, and gating ordinary mutations on it is
a locked contract in `tests/risk-policy.test.ts`.

## What is now guaranteed

Within the measured set, every command whose static argv is provably equal to
the runtime argv and whose option grammar is provably readable is either LOW or
HARD by a stated reason. Where a grammar cannot be read, the result is REVIEW,
never LOW. The fail-closed direction is the invariant; the exact tier is not.

## Measured residual boundary

These are known and deliberate, not pending work. Each was checked and the
decision recorded.

**Interpreter list is closed by decision.** `ksh`, `csh`, `tcsh`, `powershell`,
`pwsh` and `busybox sh` are not in `stringInterpreters`, so
`ksh -c 'rm -f x'` is LOW. The list was not grown because a shell list is
unbounded in the same way the config-key list was. Revisit only with a shell
that cannot be named in advance, not with a shell that merely is missing.

**Script execution is a policy question, not a bug.** `python3 script.py` is
LOW: the argv is fixed but the file's contents are not in it. Flagging every
script path also flags `npm test` and `./build.sh`, so this is a product
decision about how much ordinary work should prompt. `python3 -m pip` *is*
gated, because `-m` names a module's `__main__` in argv position and is the
same mechanism as `deno eval`, not a file path.

**`cargo owner list` is HARD.** `cargo` is verb-led (`cargo yank`) and
noun-led (`cargo owner add`) at the same time, so no single scan is correct.
The false positive is on a read-only ownership query and is left in the
fail-closed direction.

**Over-blocking was measured, not assumed.** Of 42 ordinary read-only
control-plane and package commands under an approved network lease, 1 is not
LOW (`cargo owner list`). An earlier revision of the same measurement was 6 of
42; the value-flag table in `command-effects.ts` and the attached-value rule
(`--opt=value` is self-contained and needs no entry) account for the difference.
The table is deliberately a usability budget rather than a security list: every
entry added is a class of read-only command that stays auto-approvable.

**Regression locks were checked by reverting, not by reading.** Each new test
case was run against the previous revision's source to confirm it fails there.
Seven of the added assertions fail on revert; the rest are contract cases that
hold either way and are labelled as such in the test comments.

**extglob was reported and did not reproduce.** `@(rm|echo) -f x` reaches LOW,
but neither `bash -O extglob` nor zsh expands it into a command word; bash
reports `command not found` and the file survives. It is recorded as
unreproduced rather than fixed, because the fix would cost fidelity for a hole
that was not shown to exist. zsh's `=command` *was* reproduced
(`zsh -fc '=echo hi'` prints) and is gated.

## What this note does not claim

It does not claim the static layer is complete. A shell command line and a CLI
option grammar are both open vocabularies, and a static analyser over them has
no terminating condition — every closed class exposes the next one. What the
three rounds establish is a *stable* boundary rather than a complete one: the
rules are now "unreadable means review" instead of "guess the position", so the
remaining holes are missing vocabulary rather than wrong logic.

It does not claim the residual list above is complete either. It is what was
measured, on this date, against this upstream pin.
