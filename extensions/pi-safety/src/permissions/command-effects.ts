/**
 * Command effects that outlive the process invocation itself.
 *
 * Two kinds live here, both because the sandbox cannot contain them and both
 * because they are properties of the *command*, not of the tool call:
 *
 * - process state: Unix signals reach outside SRT's filesystem and network
 *   confinement, so a signal is a side effect even with a fully known argv;
 * - external control planes: a network grant authorises the connection, not
 *   the API semantics carried over it, so `aws s3 rm` is a deletion even
 *   though the only thing the sandbox sees is a TLS connection.
 *
 * File deletion is deliberately absent: it is a filesystem effect that SRT
 * already confines, and its targets are read by `risk-policy.ts` when it
 * checks a deletion against the sandbox write roots.
 */

import type { CommandSegment } from "./rules.ts";
import { hasTerminalInfoFlag } from "./shell-segment.ts";

/**
 * Commands that act on process state rather than on files or arguments. SRT
 * confines the filesystem and the network but cannot observe Unix signals, so
 * a process-control command stays reviewable even though its argv is fully
 * determined.
 *
 * fx classifies the same primitive as `process_or_system`
 * (`command_effect.zig:894-906`). `killall` is the macOS/BSD spelling of
 * `pkill` and is not in fx's list; it is included here because leaving it next
 * to a gated `pkill` would be incoherent.
 */
const processControlExecutables = new Set(["kill", "pkill", "killall"]);

/**
 * `kill` invocations that only report: `-l` lists signal names, `--version`
 * and `--help` print and exit. None of them signal a process. Any other
 * argument form is treated as process control, so a mixed invocation such as
 * `kill -l -9 1` still reviews.
 */
const processControlReportFlags = new Set(["-l", "--list", "-L", "--table", "--version", "--help"]);

export function invocationControlsProcesses(segment: CommandSegment): boolean {
  if (!processControlExecutables.has(segment.executable)) return false;
  if (segment.executable !== "kill") return true;
  // A bare `kill` names no process; it is left to the shell to reject.
  if (segment.args.length === 0) return false;
  return !segment.args.every((arg) => processControlReportFlags.has(arg));
}

/**
 * What the static layer can prove about one invocation's remote effect.
 *
 * `proved` and `refuted` are both answers; `unknown` is the absence of one and
 * is deliberately not a synonym for `refuted`. An invocation whose option
 * grammar the table cannot read may still be a mutation with the verb hidden
 * behind an option value, so it routes to review rather than to LOW. This is
 * the only fail-open that survived a full audit of the dual-reading scan it
 * replaced: two unknown options admit four grammars, and enumerating readings
 * does not generalise past the second option.
 */
export type ExternalEffect = "proved" | "refuted" | "unknown";

/**
 * Remote-effect verdict for one invocation.
 *
 * There is no per-CLI grammar here on purpose. The reference implementations
 * have none: a search for `kubectl`, `gh`, `aws`, `gcloud`, `vercel`,
 * `netlify` or `terraform` in the pinned Codex shell-command crate returns zero
 * files, and its only dangerous-command rules are forced `rm` and an
 * exceeded-wrapper-depth bound. fx matches, and its `ApprovalReason` treats an
 * unrecognised command as `unknown_command` rather than reading intent out of a
 * verb list.
 *
 * A verb denylist cannot supply what this function is for anyway. It can show
 * that `delete` is dangerous; it cannot show that `pr edit` is, and the omission
 * is invisible — `gh pr edit`, `gh issue comment` and `gh api -X POST` all
 * auto-approved while `gh pr merge` was blocked, which is a worse answer than
 * no answer because it reads as coverage. The shared option table failed in the
 * other direction: `-p` is boolean in kubectl and `-w` is boolean in pnpm, so one
 * entry consumed the verb as an option value and `kubectl -p delete pod demo`
 * reported no mutation at all.
 *
 * So the boundary is the one both references use. What a command does to a
 * remote API is the reviewer's judgement — Guardian here, the model reviewer in
 * both references — and the boundary that is actually enforced is the network
 * lease: an invocation that needs the network and does not have it is blocked
 * before this is consulted, and the per-connection authorizer checks the real
 * host. `--version`/`--help` stay the one case this layer can settle, because a
 * leading one prints and exits and therefore cannot reach a remote API.
 */

/**
 * Package managers invoked with no subcommand, which a verb scan cannot read:
 * there is no verb, so the scan finds nothing and reports no mutation.
 *
 * Only `yarn` stays on that routing. Measured on this machine: `npm` (11.17.0)
 * prints usage and exits 1, `pnpm` prints usage on stderr and exits 2, `bun`
 * (1.3.14) prints its command list and exits 0 — all three are usage/help
 * listings with no mutation, so a bare invocation of them is decomposable and
 * simply Skips. Only `yarn` (1.22.22, the classic line) actually ran `install`
 * — logging `[1/4] Resolving packages…` through `[3/4] Linking dependencies…`
 * and exiting 1 — so bare `yarn` keeps its guarded review.
 *
 * This is the same shape as the reference implementation's listing, not a
 * per-tool grammar: `command_effect.zig:147-170` returns `false` at
 * `words.len == 0` for the package runners there; the review is routing, not
 * a claim about what each tool does.
 */
const bareInvocationRunsActions = new Set(["yarn"]);

/**
 * Whether this invocation's remote effect is unprovable, so a reviewer decides.
 *
 * There is no per-CLI grammar here, and that is deliberate. A search for
 * `kubectl`, `gh`, `aws`, `gcloud`, `vercel`, `netlify` or `terraform` in the
 * pinned Codex shell-command crate returns zero files, and its only
 * dangerous-command rules are forced `rm` and an exceeded wrapper-depth bound;
 * fx matches and treats an unrecognised command as `unknown_command` rather than
 * reading intent out of a verb list. A verb denylist could not have supplied
 * this function anyway. It can show `delete` is dangerous; it cannot show
 * `pr edit` is, and the omission is invisible — `gh pr edit` and
 * `gh api -X POST` auto-approved while `gh pr merge` was blocked, which reads as
 * coverage without being any. The shared option table failed the other way:
 * `-p` is boolean in kubectl and `-w` is boolean in pnpm, so one entry swallowed
 * the verb as an option value and `kubectl -p delete pod demo` reported no
 * mutation at all.
 *
 * So the boundary is the one both references use. What a command does to a
 * remote API is the reviewer's judgement, and the boundary that is actually
 * enforced is the network lease: an invocation needing the network without it is
 * blocked before this is consulted, and the per-connection authorizer checks the
 * real host.
 */
export function invocationRemoteEffectUnclassified(segment: CommandSegment): boolean {
  // `--version`/`--help` print and exit, but only in the first argument position
  // — the only place no earlier option can consume one as a value, so
  // `gh pr create --title --help --body x` still creates the pull request.
  if (hasTerminalInfoFlag(segment.args)) return false;
  return bareInvocationRunsActions.has(segment.executable) && segment.args.length === 0;
}
