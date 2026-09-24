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

## The five rounds that produced the current shape

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

Round 4 (`716a13e`) reviewed round 3 and found two more logic errors, both
introduced *by* the round-3 fix rather than pre-existing.

Round 5 (this commit) reviewed round 4 and found that its terminal-flag rule
was still positional rather than structural, in the same place as twice before.

They are recorded here because the pattern matters more than the individual
holes: each round's repair created a new fail-open somewhere adjacent, and only
adversarial review caught it.

| Round | Introduced | Caught by |
| --- | --- | --- |
| 2 | dual-reading operand union (2^N grammars) | round 3 review |
| 3 | terminal-flag short-circuit firing on any position | round 4 review |
| 3 | `git config` key read without consuming value options | round 4 review |
| 4 | terminal-flag rule narrowed to "before the first operand" | round 5 review |

The last row is the one worth reading twice. Round 4's rule was "honour
`--help` only where no operand precedes it", which is *almost* right and still
wrong: an option before the flag is exactly the thing that can consume it.
`kubectl --as --help delete pod demo` prompts for a username and then deletes.
Position was being used as a proxy for role, three rounds running.

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

**The terminal-flag rule is now the first argument and nothing else.** Rounds 3
and 4 each tried to widen or narrow "where is `--help` terminal" and both were
wrong, because position was standing in for role. The rule that holds is the
narrowest one: only `args[0]`, because only the first argument has nothing in
front of it that could consume it. `hasTerminalInfoFlag` is shared by the
interpreter analysis and the external-CLI analysis so the two cannot drift, and
both of the round-4 holes were that same rule applied in two places —
`python3 -W --help` runs the program on stdin while printing only a warning.

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

Matching is on the key's final dotted segment, which keeps the list short
without naming namespaces. That has one exception the review found by
executing it: a namespace whose tail is author-chosen rather than fixed carries
no information in its last segment. `alias.name` ends in a perfectly ordinary
scalar name and is still a program — `git -c 'alias.name=!touch probe' name`
created the file — so `alias.` and `pager.` are excluded before the segment is
read. The rule is "fixed tail ⇒ name it, arbitrary tail ⇒ never safe", and the
bug was applying the first half without the second.

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

**Interpreter startup environment is not modelled.** `BASH_ENV=evil.sh bash -c
true` runs the file before the command, and `NODE_OPTIONS=--require=preload.cjs
node main.cjs` preloads a module; both are LOW and both execute. This is a
vector class rather than a gap: `BASH_ENV`, `ENV`, `NODE_OPTIONS`, `RUBYOPT`,
`PERL5OPT`, `PYTHONSTARTUP` and whatever each runtime adds next are the same
shape, so closing it means the same allowlist-versus-blocklist problem that the
Git config key check had. It is recorded as open rather than half-closed.

**Argument expansion can produce a dangerous flag.** `FORCE=-f rm "$FORCE"
victim` is LOW and the file is force-deleted. This is the argument-position
counterpart of the command-word expansion that is gated, and it is *not* closed:
the sound rule would be "any unexpanded word in an argument of a deletion
command", which also flags `rm "$FILE"` — an ordinary and safe invocation. The
cost is a product decision about how often a quoted variable path should
prompt, not a correctness question, so it is left to whoever owns that tradeoff.

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

**extglob was reported three times and did not reproduce.** `@(rm|echo) -f x`
reaches LOW, and the segmenter does split it into `@`, `rm`, `echo`, `-f x`, so
the report is mechanically accurate. It does not execute. Ten forms were tried
across `bash -O extglob` and zsh — `@(rm)`, `@(echo|rm)`, `+(rm)`, `?(rm)`,
`*(rm)`, `@(/bin/ls|echo)` — and in every case bash reported `command not
found` and the file survived. Bash does not apply extglob patterns to the
command word. This is recorded as unreproduced after repeated attempts rather
than fixed, because the fix would cost parser fidelity for a hole that three
separate reviews failed to demonstrate. zsh's `=command` *was* reproduced
(`zsh -fc '=echo hi'` prints) and is gated.

## What this note does not claim

It does not claim the static layer is complete. A shell command line and a CLI
option grammar are both open vocabularies, and a static analyser over them has
no terminating condition — every closed class exposes the next one. What the
five rounds establish is a *stable* boundary rather than a complete one: the
rules are now "unreadable means review" instead of "guess the position", so the
remaining holes are missing vocabulary rather than wrong logic. That
characterisation is a judgement made on this date, not a proof; the honest
summary of five rounds is that each one found the previous one's logic error,
and the argument that the current logic has none rests on the rule being
narrowest-possible rather than on the review being exhaustive.

It does not claim the residual list above is complete either. It is what was
measured, on this date, against this upstream pin.
