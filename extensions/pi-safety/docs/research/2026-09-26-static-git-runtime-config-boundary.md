# The Static Risk Layer Does Not Read Git's Runtime Configuration

## Scope

- Date: 2026-09-26
- Codex pin (standing): `129fd21687fbd4ac48133b7abfdcaf52cb6cb01f`
- Host pin: `@earendil-works/pi-coding-agent@0.86.0`
- Tree: `extensions/pi-safety` at `3bc0a10`
- Question: four classes of command reach a program or a destination that the
  static layer never sees. They share one root cause, they have no reference
  implementation to align with, and the decision not to close them is recorded
  here so it is a choice rather than an omission.
- Deliverable: **the boundary, the evidence for it, and why detection was
  declined.** Nothing in this note changes behaviour.

### What this note does not claim

- It does not claim the classes below are unreachable. They are reachable, and
  the tables say which were executed.
- It does not claim the static layer is otherwise complete. This note covers the
  configuration boundary only; `hash` and `alias` are a different boundary and
  are listed separately below.
- It does not claim a runtime consequence was observed inside the extension. Every
  execution below was run against `git 2.50.1 (Apple Git-155)` on the host, with a
  marker file as the witness. None of it was run through the extension's sandbox,
  so what the sandbox would have contained is not established either way.
- It does not claim the references are safe. Both leave these cases to something
  else, and "something else" is named per case below.

## The root cause

One sentence: **this layer classifies the words on the command line, and Git's
behaviour is also a function of state the command line does not carry.**

Three sources of that state, and they need different responses:

1. **Configuration that already exists** — in `.git/config`, `$HOME/.gitconfig`,
   the XDG path, or wherever `GIT_CONFIG_GLOBAL` points. Verified executing with
   nothing in the command:

   | configuration | command | executed |
   |---|---|---|
   | `alias.whoami = !touch M` | `git whoami` | yes |
   | `core.fsmonitor = touch M` | `git status` | yes |
   | `diff.probe.textconv = touch M` | `git diff` | yes |

   Further shapes were reported by adversarial review and are plausible on the
   same grounds — `core.hooksPath`, `credential.helper`, `filter.*.clean`,
   `core.sshCommand`, `core.alternateRefsCommand`, `remote.*.uploadpack`,
   `submodule.*.update`, `merge.*.driver`, `sequence.editor`, `gpg.program`,
   `core.pager` — but only the three above were executed here, and the rest are
   recorded as reported rather than verified. An earlier draft of this note gave a
   count for that list; the count was carried from a review summary without being
   checked and is withdrawn.

2. **Configuration the command line writes** — `-c KEY=VALUE`,
   `--config-env`, and the other writers. `url` was removed from
   `gitScalarConfigSegments` for this reason; the remaining writers are
   `git remote set-url`, `git submodule set-url`, `git clone --config=`, and the
   `--reference` family.

3. **Program-valued options in Git's own grammar.** Executed here:

   | command | executed |
   |---|---|
   | `git fetch --upload-pack='touch M' <repo>` | yes |
   | `git grep --open-files-in-pager='touch M' <pat>` | yes |

   Not demonstrated, and therefore not claimed either way:
   `git difftool --extcmd=…` (needs a configured external driver; a non-tty run
   used the built-in difftool) and `git send-email --sendmail-cmd=…` (failed
   earlier in the pipeline, at address extraction).

   `git archive --remote='ext::…'` is a fourth shape that **Git itself refuses**:
   `fatal: transport 'ext' not allowed`.

### A correction to how the `ext::` evidence should be read

`f7417cf` records that
`git -c remote.evil.url='ext::touch /tmp/marker' ls-remote evil` created the
marker. That is true, and the repository used for it had
`protocol.ext.allow=always` set — which this note did not say at the time, and
which is a precondition rather than a detail:

```
git -c remote.e.url='ext::touch M' ls-remote e
  → fatal: transport 'ext' not allowed          did not run
git -c protocol.ext.allow=always -c remote.e.url='ext::touch M' ls-remote e
  → created the marker                            ran
```

So the `ext::` code execution requires the user to have enabled the external
remote-helper transport. The fix stands — a user who enabled it for one workflow
gets arbitrary execution from any `-c`, and the static layer does not read the
setting that enabled it — but the severity is conditional, not unconditional.

## What the references do

Neither reads Git's configuration, and they differ in kind.

**Codex** has no Git arm in its static layer at all, and its signal has no room
for one. `DangerousCommandMatch` (`shell-command/src/command_safety/is_dangerous_command.rs:27`)
has exactly two variants, `ForcedRm` and `Other`, returned as
`Option<DangerousCommandMatch>` — a binary match-or-not with no third
"unprovable" state, and no `git` case anywhere in the file at this pin.

What Codex does instead is systematic neutralisation, and it is worth being
precise about the shape of it because it is the opposite of a static check. When
Codex runs Git itself it removes the execution surface rather than inspecting the
configuration for danger: a `DISABLED_HOOKS_PATH` constant (`NUL` on Windows,
`/dev/null` otherwise) is passed as `core.hooksPath` from `git-utils/src/operations.rs:127`,
`git-utils/src/info.rs:421` and `worktree/src/git.rs:126`, so the
`git-utils` and worktree paths all carry it. `core.fsmonitor` gets its own module
for the same reason — `git-utils/src/fsmonitor.rs:3` states it as *"Codex
overrides `core.fsmonitor` so repository configuration cannot select"*, citing the
upstream `git-fsmonitor-daemon` documentation. The TUI's `/diff` adapter does the
same for filter drivers: `diff_filter_config_overrides`
(`tui/src/get_git_diff.rs:163`) enumerates the configured `filter.*.clean` and
`filter.*.process` keys with `config --get-regexp` against
`EXECUTABLE_FILTER_CONFIG_PATTERN` (`:24`), strips the suffix to recover the
driver names, and returns an override per driver. Its doc comment is the whole
thesis in one line: *"Return Git configuration overrides that prevent configured
filter drivers from executing while generating diffs."*

So Codex's answer to a pre-existing configuration value is to find it and neutralise
it, at every point where it runs Git — not to reason about it in a static check.

**fx** reads no Git configuration either, and neutralises the same two keys at
`command_effect.zig:742-744` — `core.hooksPath=/dev/null` *and*
`core.fsmonitor=false`. Its Git arm is structural rather than configurational, and
it is worth stating precisely because it is a real answer to class 3 below.
`planGit` (`:723-732`) plans exactly three subcommands:

```zig
if (words.len < 2) return .{ .approval_required = .command_owned_input };
if (std.mem.eql(u8, words[1], "status")) return planGitStatus(alloc, words[2..]);
if (std.mem.eql(u8, words[1], "diff")) return planGitDiff(alloc, words[2..]);
if (std.mem.eql(u8, words[1], "log")) return planGitLog(alloc, words[2..]);
return .{ .approval_required = .command_owned_input };
```

Bare `git`, and every subcommand other than `status` / `diff` / `log`, is
`command_owned_input` — a review. So `git fetch --upload-pack=…` is caught, but by
the *width of the planned set*, not by any knowledge of program-valued options:
there is no such list in fx (grep for `upload-pack`, `--exec`, `extcmd`,
`sendmail-cmd`, `receive-pack` returns nothing). The separate, coarser
`reversibleGit` (`:126-145`) allows `status`, `remote -v`, `worktree list` and a
`fetch` that carries none of `--prune` / `-p` / `--prune-tags`.

`command_owned_input` is also how fx answers a relocation: `git -C other status`
is in its review table with that reason (`:1172`), alongside `git push origin
HEAD`. That agrees with this package's `git -C` handling and with what
`3bc0a10` did for `cd` — both review rather than approve, for the same reason.

fx is far more conservative than this package on shapes, though not uniformly.
`planCat` (`:647-657`) accepts `cat` with no arguments at all, so `cat README.md`
is a review. But `git status --short --branch` is allowed (`:1118`) while
`git status --short -- src` is not (`:1175`) — the per-subcommand planners check
operands, not just the subcommand. So "fx reviews ordinary Git" would be wrong;
it reviews ordinary *non-planned* Git, and plans three subcommands closely.

The `ext::` transport is additionally refused by Git itself unless
`protocol.ext.allow` says otherwise, so part of that class is already the
upstream's decision rather than this layer's.

## Why detection was declined

Reading Git's runtime configuration from the static layer would mean resolving
`$HOME`, the XDG path, `include` / `includeIf` directives, `GIT_CONFIG_GLOBAL`,
and the repository's own config, then treating the result as authoritative. That
is a different model from the one this layer uses, and the existing code already
says so in two places:

- `git-metadata.ts` reads repository configuration for **implicit remote host
  discovery only**, and `risk-policy.ts` states the limit plainly: it follows no
  `include`/`includeIf`, no `config.worktree`, no `url.*.insteadOf`, and no
  environment relocation, "so a parse that yields a host is not proof and a parse
  that yields none is not proof either".
- `sandbox-policy.ts` denies writes under the discovered metadata roots. That is
  a filesystem policy, not a proof that a pre-existing value is harmless.

The alternative the references use — neutralise at the point of invocation — does
not apply to a command line the agent is being asked to approve. There is nothing
to neutralise in `git fetch --upload-pack=…`; the option is the attack.

fx offers a third route, and it is the one that actually covers class 3: make the
planned set small enough that everything outside it is a review. `planGit` plans
`status`, `diff` and `log`; `fetch --upload-pack=…` never reaches a planner.
This package cannot take that route cheaply, because its Git surface is the
opposite shape. `AGENTS.md` records the intent — "Git mutations, including
`init`, remain ordinary sandbox executions" — and the static layer matches it:
`git init`, `git add .`, `git commit -am x` and `git fetch origin` all return
`allow` / `Skip` today. Narrowing the planned set to three subcommands would turn
most of `git` into review. That is a product change about how much Git this layer
claims to understand, not a correction to a gap, and it is why it is recorded
here rather than done.

So the honest options were: read the configuration and accept a resolution model
this layer does not have; narrow the planned Git set to what can be proven and
review the rest; or leave the boundary declared. The second is defensible and is
the one to revisit if the cost of the first is judged too high. This note records
the third, as a decision.

## A separate boundary: program identity is not established at all

`hash -p` rebinds a command word to an arbitrary program while the word itself
stays the same. Demonstrated on the host:

```
$ hash -p /usr/bin/touch git
$ git /tmp/marker            # created /tmp/marker
```

The static layer sees the token `git` in both positions. `evaluateRiskRequest`
returns `allow` / `Skip` for `hash -p /usr/bin/touch git; git /tmp/x`, so the
program that runs is not the program that was classified.

`alias git=/bin/echo; git status` is the same shape and is also returned as
`allow` / `Skip`, but **it is not demonstrated here**: `alias` does not expand at
all in this environment's non-interactive bash, including for a name that exists
nowhere else (`alias myls=…` followed by `myls` gives "command not found"). It is
recorded as reported-and-classified-`Skip`, not as verified execution.

This is **not** the configuration boundary — no configuration is involved — and it
is listed separately so the two are not conflated.

Neither reference has a mechanism for this. Codex's
`core/src/exec_policy/executable_identity.rs` is a 107-line module with one
function, `shell_approval_command`, and it is about the *wrapper* the approval
request names rather than the command word inside it. Its reasoning is worth
quoting because it is a real property: it evaluates the executable alongside its
apparent commands so that "inner commands can add restrictions, but cannot grant
the executable trust" (`:44`), and it keeps an unfamiliar executable separate
because "an unfamiliar executable can ignore its arguments" (`:99`). That is about
wrapper identity, not about which binary a bare command word resolves to. An
earlier draft of this note gave a path-traversal example for that rejection; no
such example exists in the file, and the claim is withdrawn.

fx has nothing corresponding. `which` is classified as an ordinary
operand-taking command (`command_effect.zig:92`, `words.len > 0 and
allOperands(words)`) — it answers the question, it does not participate in
deciding it. An earlier draft of this note claimed fx had a `which`-based identity
check; it does not.

Closing this means deciding program identity for every executable, not only for
Git — which is a larger design question than this layer has been asked. Note that
`3bc0a10` made the *root* observable for the `cd` case without claiming to solve
identity: a relocation is now a review, which is where an unidentifiable program
belongs.

## What would change the decision

- A Git API that reports the resolved configuration for a repository, so the
  resolution model is Git's rather than this layer's.
- Evidence that the sandbox plus the connection boundary already contains these,
  measured rather than assumed. Nothing in this note establishes that, and
  `G3 evidence audit` (`2026-09-10-g3-evidence-audit.md`) is explicit that
  hermetic coverage is not native proof.
- A decision that the configuration boundary is worth a resolution model of its
  own, at which point classes 1–3 above are one piece of work rather than three.
