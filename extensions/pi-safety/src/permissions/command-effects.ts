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
 * Global options that take a value across the CLIs below, so the word after one
 * is an option value rather than the subcommand. A flag that is *not* here and
 * appears before the verb makes the grammar unprovable, so this table is a
 * usability budget as much as a safety table: every entry added is a class of
 * read-only command that stays auto-approvable.
 */
const cliGlobalValueFlags = new Set([
  "-n",
  "--namespace",
  "-c",
  "--context",
  "--project",
  "--profile",
  "-p",
  "--region",
  "-g",
  "--group",
  "--cluster",
  "-u",
  "--user",
  "-t",
  "--tenant",
  // The second tier: value-taking options common enough on read-only queries
  // that leaving them out would push ordinary inspection into review.
  "--repo",
  "-R",
  "--format",
  "--output",
  "-o",
  "--query",
  "--jq",
  "--filter",
  "--fields",
  "--limit",
  "--page",
  "--per-page",
  "--state",
  "--sort",
  "--search",
  "--assignee",
  "--author",
  "--label",
  "--milestone",
  "--since",
  "--until",
  "--chdir",
  "--prefix",
  "--workspace",
  "-w",
  "--template",
  "--params",
  "--values",
  "--set",
  "--values-file",
  // Resource selectors, which are values on the mutation forms these tools are
  // gated for (`aws ec2 terminate-instances --instance-ids i-1`).
  "--instance-ids",
  "--ids",
  "--name",
  "--names",
  "--zone",
  "--location",
  "--resource-group",
  "--subscription",
]);

/**
 * The operand positions at which a verb may appear, or `undefined` when the
 * option grammar makes the positions unprovable.
 *
 * There is no fixed verb depth to scan to. `kubectl exec` puts the verb first,
 * `aws s3 rm` second, `gcloud compute instances delete` third, and
 * `gcloud compute instance-groups managed delete` fourth, so the scan
 * collects every operand rather than a window — a window silently drops the
 * deepest forms, which is the fail-open this replaces.
 *
 * The cost of no window is that an option *value* can be mistaken for an
 * operand. That is only a problem for tools whose verb sits at a known
 * position, which is why `collect` caps those separately: `terraform` reads
 * one operand, so `-out apply` in `terraform plan -out apply` contributes
 * nothing instead of being read as the verb `apply`.
 *
 * An option outside `valueFlags` is the real ambiguity: it may consume the
 * next word, shifting every later operand one position left. Guessing is not
 * sound — with two such options there are four readings, and enumerating them
 * does not generalise. The scan gives up instead, but only while the shift
 * could still hide the verb. Once any operand has been read, skipping the
 * option without its value leaves every later operand in the list one place
 * to the right, and the verb is still in there: a shift can only introduce a
 * spurious candidate, never remove a real one. That is why the threshold is
 * one operand rather than a full window — `kubectl get pods --all-namespaces`
 * has long since named its verb, and the flag after it cannot move it.
 *
 * `nounLed` tools put a noun first, so that position is dropped before the
 * result is read as a verb.
 */
function verbOperands(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
  nounLed: boolean,
  collect: number,
): string[] | undefined {
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (operands.length >= collect) break;
    if (token === "--") {
      // Everything after the separator is positional by definition. Nothing
      // there can be an option value, so the verb can no longer move and the
      // ambiguity that would otherwise abort the scan does not apply.
      operands.push(...args.slice(index + 1).map((rest) => rest.toLowerCase()));
      break;
    }
    if (valueFlags.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      if (operands.length === 0) return undefined;
      continue;
    }
    operands.push(token.toLowerCase());
  }
  return nounLed ? operands.slice(1) : operands;
}

/**
 * CLI verbs are sometimes compound (`terminate-instances`, `delete-bucket`),
 * so a `verb-` prefix counts as the verb. An exact-only match would let those
 * through, while the prefixes used here (`get-`, `list-`, `describe-`) are not
 * themselves mutation verbs.
 */
function matchesMutationVerb(operand: string, verbs: ReadonlySet<string>): boolean {
  if (verbs.has(operand)) return true;
  const dash = operand.indexOf("-");
  return dash > 0 && verbs.has(operand.slice(0, dash));
}

/** Subcommands that mutate remote state through a control-plane API. */
const cliMutationVerbs = new Map<string, ReadonlySet<string>>([
  [
    "kubectl",
    new Set([
      "annotate",
      "apply",
      "attach",
      "autoscale",
      "cordon",
      "cp",
      "create",
      "debug",
      "delete",
      "drain",
      "edit",
      "exec",
      "expose",
      "label",
      "patch",
      "port-forward",
      "replace",
      "rollout",
      "run",
      "scale",
      "set",
      "taint",
    ]),
  ],
  [
    "aws",
    new Set([
      "attach",
      "authorize",
      "cancel",
      "copy",
      "create",
      "delete",
      "deploy",
      "deregister",
      "detach",
      "disable",
      "disassociate",
      "enable",
      "import",
      "install",
      "invoke",
      "modify",
      "publish",
      "put",
      "reboot",
      "reinstall",
      "register",
      "release",
      "remove",
      "replicate",
      "reset",
      "restore",
      "revoke",
      "rm",
      "run",
      "start",
      "stop",
      "sync",
      "terminate",
      "unassociate",
      "unregister",
      "update",
    ]),
  ],
  [
    "gcloud",
    new Set([
      "add-iam-policy-binding",
      "create",
      "delete",
      "deploy",
      "destroy",
      "remove-iam-policy-binding",
      "set-iam-policy",
      "start",
      "stop",
      "update",
    ]),
  ],
  ["az", new Set(["create", "delete", "destroy", "remove", "start", "stop", "update"])],
  ["helm", new Set(["install", "rollback", "uninstall", "upgrade"])],
  [
    "gh",
    new Set([
      "cancel",
      "close",
      "create",
      "delete",
      "deploy",
      "merge",
      "publish",
      "reopen",
      "rerun",
      "sync",
    ]),
  ],
  ["npm", new Set(["deprecate", "dist-tag", "owner", "publish", "unpublish"])],
  ["pnpm", new Set(["deprecate", "owner", "publish", "unpublish"])],
  ["yarn", new Set(["deprecate", "owner", "publish", "unpublish"])],
  ["cargo", new Set(["owner", "publish", "yank"])],
  ["twine", new Set(["upload"])],
  ["poetry", new Set(["publish"])],
  ["doctl", new Set(["create", "delete", "rename", "update"])],
]);

/**
 * Tools whose first operand is a noun rather than a verb, so only the second
 * operand may be read as the verb. `gh run list` is read-only even though
 * `run` is a mutation verb elsewhere; every other tool is scanned across the
 * first three, because `kubectl exec`, `aws s3 rm`, and
 * `gcloud compute instances delete` place the verb at different depths.
 */
const cliNounLedCommands = new Set(["gh"]);

/**
 * `terraform`/`tofu` mutating subcommands. They are reached through the shared
 * operand scan rather than `args[0]`, so a global option ahead of the verb
 * (`--chdir DIR`, `-var NAME=VALUE`) cannot hide it.
 */
const terraformMutationSubcommands = new Set([
  "apply",
  "destroy",
  "force-unlock",
  "import",
  "refresh",
  "taint",
  "untaint",
]);

/** CLIs whose bare invocation already deploys or mutates external state. */
const wholeInvocationIsExternal = new Set(["vercel", "netlify", "wrangler", "flyctl", "heroku"]);

export function invocationHasExternalSideEffect(segment: CommandSegment): ExternalEffect {
  // `--version` and `--help` print and exit for every tool in these tables, so
  // the invocation cannot be a mutation whatever its other options say. This is
  // checked before the grammar scan because an otherwise-unreadable option list
  // is common on exactly these two forms (`gh --version`).
  if (hasTerminalInfoFlag(segment.args)) return "refuted";
  if (wholeInvocationIsExternal.has(segment.executable)) {
    // These CLIs deploy by default, so the invocation as a whole is external.
    return "proved";
  }
  // `terraform`/`tofu` put global options before a verb that is always the
  // first operand, so one operand settles it. Every other tool is verb-led at a
  // depth that varies by subcommand, so all operands are collected and the verb
  // is looked for at any of them.
  const terraform = segment.executable === "terraform" || segment.executable === "tofu";
  const verbs = terraform ? terraformMutationSubcommands : cliMutationVerbs.get(segment.executable);
  if (verbs === undefined) return "refuted";
  const nounLed = cliNounLedCommands.has(segment.executable);
  const operands = verbOperands(
    segment.args,
    cliGlobalValueFlags,
    nounLed,
    terraform ? 1 : Number.POSITIVE_INFINITY,
  );
  // An option grammar this table cannot read is not evidence of safety.
  if (operands === undefined) return "unknown";
  return operands.some((operand) => matchesMutationVerb(operand, verbs)) ? "proved" : "refuted";
}
