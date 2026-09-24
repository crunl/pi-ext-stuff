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
 * Global options that take a value across the CLIs below, so the word after one
 * is an option value rather than the subcommand.
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
]);

/**
 * The operand positions at which a verb may appear, under one reading of the
 * options this table does not know.
 *
 * Verb depth varies by tool — `kubectl exec` puts it first, `aws s3 rm` and
 * `gh pr merge` second, `gcloud compute instances delete` third — so callers
 * pass how many leading positions to collect. `nounLed` tools put a noun
 * first, so that position is dropped before the result is used as a verb.
 *
 * `unknownOptionTakesValue` decides what to do with a flag outside
 * `valueFlags`: when true the following word is consumed as its value, when
 * false the scan continues past the flag alone. Neither reading can be chosen
 * without knowing the tool's grammar, so the caller runs both and unions them.
 */
function verbOperands(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
  nounLed: boolean,
  unknownOptionTakesValue: boolean,
  limit: number,
): string[] {
  const operands: string[] = [];
  for (let index = 0; index < args.length && operands.length < limit; index += 1) {
    const token = args[index] ?? "";
    if (valueFlags.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      if (unknownOptionTakesValue) index += 1;
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

export function invocationHasExternalSideEffect(segment: CommandSegment): boolean {
  if (wholeInvocationIsExternal.has(segment.executable)) {
    // These CLIs deploy by default, so the invocation as a whole is external.
    // A version or help query still only prints.
    return !hasTerminalInfoFlag(segment.args);
  }
  // `terraform`/`tofu` take global options before the verb, and the verb is the
  // first operand (`terraform --chdir /tmp apply`). They go through the same
  // operand scan as every other tool rather than reading `args[0]`, which would
  // have read `/tmp` as the subcommand and missed the apply.
  const verbs =
    segment.executable === "terraform" || segment.executable === "tofu"
      ? terraformMutationSubcommands
      : cliMutationVerbs.get(segment.executable);
  if (verbs === undefined) return false;
  const nounLed = cliNounLedCommands.has(segment.executable);
  // `terraform`/`tofu` take global options before the verb, and the verb is the
  // first operand, so only that one position is read. A wider window would
  // read `-out apply` in `terraform plan -out apply` as the verb `apply`, when
  // `apply` is the plan file's name and the subcommand is the read-only
  // `plan`. The other tools are verb-led deeper, so they read three.
  const limit = verbs === terraformMutationSubcommands ? 1 : 3;
  // An option outside the table is scanned both ways and the two readings are
  // unioned, so `gcloud --format json compute instances delete vm` reaches
  // `delete` under the value-taking reading and `gcloud --quiet compute
  // instances delete vm` reaches it under the value-less one. Skipping the
  // unknown flag outright would let a value-taking option consume an operand
  // slot and push the verb out of the window — the fail-open this replaces.
  const candidates = [
    ...verbOperands(segment.args, cliGlobalValueFlags, nounLed, true, limit),
    ...verbOperands(segment.args, cliGlobalValueFlags, nounLed, false, limit),
  ];
  return candidates.some((operand) => matchesMutationVerb(operand, verbs));
}
