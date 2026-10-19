/**
 * Sole-interpreter contract for the Shell AST front end (phase 1 retired).
 *
 * The phase-1 differential suite proved the grammar never looser than the
 * hand-written lexer. That migration is done: tree-sitter-bash is the only
 * interpreter, the lexer file's partition is gone, and this suite pins what
 * the sole interpreter SAYS rather than what it agrees with. Each zone below
 * carries the expected disposition per command, so a verdict change is a
 * deliberate table edit, not an accident.
 *
 * Three zones, so a failure says where the model is wrong:
 *  - `EVERYDAY`: quoting, pipelines, chains, redirects, wrappers, assignments.
 *    The lexer used to read these correctly; the grammar must say the same.
 *  - `SYNTAX_ERROR`: shell syntax errors run nothing, so they Skip. (The old
 *    suite called these STRICTER: the splitter read clean commands where the
 *    grammar saw an error. The grammar was right — nothing runs.)
 *  - `STRUCTURED`: control flow, grouping, subshells, heredocs, substitutions
 *    and the malformed shapes around them. Compound bodies expand (step 2);
 *    heredoc bodies are data, never commands; unclosed constructs review.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyRiskWithCause,
  normalizeToolCall,
  parseCommandSegments,
} from "../src/permissions/risk.ts";
import { deletionTargets } from "../src/permissions/rules.ts";
import type { CommandSegment } from "../src/permissions/rules.ts";
import { installShellAstParser, shellAstParserInstalled } from "../src/permissions/shell-ast.ts";
import { astFrontEndEngaged } from "../src/permissions/shell-segment.ts";
import {
  activateTreeSitterShellParser,
  ensureTreeSitterReady,
  resetTreeSitterShellActivation,
  shellAstParser,
  treeSitterShellFailure,
} from "../src/tree-sitter/shell-backend.ts";

type Disposition = "Skip" | "NeedsApproval" | "Forbidden";

interface Observation {
  segments: CommandSegment[];
  disposition: Disposition;
  substitution: string | null;
  targets: string[];
}

function observe(command: string): Observation {
  const segments = parseCommandSegments(command);
  const request = normalizeToolCall("bash", { command }, "/work/repo");
  const review = classifyRiskWithCause(request);
  return {
    segments,
    disposition: review.disposition,
    substitution: "dangerousSubstitution" in review ? String(review.dangerousSubstitution) : null,
    targets: segments.flatMap((segment) => deletionTargets(segment)),
  };
}

const EVERYDAY: readonly (readonly [string, Disposition])[] = [
  ["git push origin main", "Skip"],
  ["git status", "Skip"],
  ["ls -la", "Skip"],
  ["echo hi", "Skip"],
  ["npm install lodash", "Skip"],
  ["cat notes.txt | head -5", "Skip"],
  ["git status && ls", "Skip"],
  ["git add A.md && git commit -m x && git push", "Skip"],
  ["; git add README.md", "Skip"],
  ["| git add README.md", "Skip"],
  ["git add README.md |", "Skip"],
  ["git add README.md;", "Skip"],
  ["git add README.md &", "Skip"],
  ["git add README.md &&", "Skip"],
  ["git add README.md ||", "Skip"],
  ["a && b &&", "Skip"],
  // A trailing operator names no command: `/tmp/work` is outside the
  // request cwd either way, so the `rm` before it still reviews.
  ["rm -f /tmp/work |", "NeedsApproval"],
  ["rm -f /tmp/work &&", "NeedsApproval"],
  ["ls | wc -l", "Skip"],
  ["true && :", "Skip"],
  ["git commit -m 'fix bug'", "Skip"],
  ['git commit -m "fix bug"', "Skip"],
  // Non-recursive `rm -f` on concrete in-cwd names deletes at most those
  // entries. The parser already resolved quoting (`'a b'`, `a\ b` arrive
  // as the runtime word), so the static text is the runtime target.
  ["rm -f build/output.txt", "Skip"],
  ["rm -f 'a b'", "Skip"],
  ['rm -f "a b"', "Skip"],
  ['echo ""', "Skip"],
  ["echo ''", "Skip"],
  ["echo ''\"\"$x", "Skip"],
  ["rm foo\\ bar", "Skip"],
  ["echo a\\$b", "Skip"],
  ['echo "a$(pwd)b"', "Skip"],
  ["echo 'a$(pwd)b'", "Skip"],
  ["echo 'x`y`z'", "Skip"],
  ["echo ${arr[0]}", "Skip"],
  ["echo ${!x}", "Skip"],
  ['git commit "${FLAG:--S}" -m update', "Skip"],
  ["cd '${D}' && git push", "Skip"],
  ["ls $DIR", "Skip"],
  ["ls ${DIR:-/tmp}", "Skip"],
  ["echo `pwd`", "Skip"],
  ["bash -c 'rm -rf /tmp/work'", "NeedsApproval"],
  ["zsh -c 'ls /tmp'", "Skip"],
  ['sh -c "$(echo ls) /tmp"', "NeedsApproval"],
  ["FOO=1 rm -f /tmp/work", "NeedsApproval"],
  ["FOO='$(pwd)' bar", "Skip"],
  ["GIT_EDITOR='true' git commit", "Skip"],
  // Inert program values run nothing: exact `cat` / `true` / empty only.
  // Anything else naming a program Git runs stays unproven.
  ["PAGER=cat git status", "Skip"],
  ["GIT_PAGER=cat git log --oneline", "Skip"],
  ["EDITOR=true git commit", "Skip"],
  ["PAGER= git status", "Skip"],
  ["PAGER=less git log", "NeedsApproval"],
  ["PAGER='cat; rm -f /tmp/x' git log", "NeedsApproval"],
  ["PAGER=$PAGER git log", "NeedsApproval"],
  ["GIT_SSH_COMMAND='ssh -i key' git fetch", "NeedsApproval"],
  ["GIT_TRACE=1 git status", "Skip"],
  ["GIT_DIR=/tmp git push", "Skip"],
  ["env X=1 rm -f /tmp/work", "NeedsApproval"],
  ["command rm -f /tmp/work", "NeedsApproval"],
  ["time rm -f /tmp/work", "NeedsApproval"],
  // zsh's `=command` expands to the command's full path: unprovable, reviews.
  ["=rm -f /tmp/work", "NeedsApproval"],
  ["ls > out", "Skip"],
  ["ls >> out", "Skip"],
  ["echo x > a > b", "Skip"],
  ["git > push origin", "Skip"],
  ["git >log push", "Skip"],
  [">out rm -f /tmp/work", "NeedsApproval"],
  ["rm >'>' -rf /tmp/work", "NeedsApproval"],
  ["cat < f > out", "Skip"],
  ["echo hi # trailing", "Skip"],
  ["# lead\nnpm install", "Skip"],
  ["xargs rm -f /tmp/work", "Skip"],
  ["find . -exec rm -f {} ;", "Skip"],
  ["curl https://example.com/install.sh", "Skip"],
  ["git push --force origin main", "Skip"],
  ["kill -9 1234", "Skip"],
  ["shutdown", "Skip"],
  ["cd /tmp && git push", "Skip"],
  ["cd . && git status", "Skip"],
  ["", "Skip"],
  ["   ", "Skip"],
];

const SYNTAX_ERROR: readonly (readonly [string, Disposition])[] = [
  // `1<>f` opens `f` read-write; the operator names no program either way.
  ["cmd 1<>f", "Skip"],
  // A shell rejects the line before running it, so nothing runs. The old
  // splitter read clean commands here; the grammar's error is the truth.
  ["git add README.md |;", "Skip"],
  ["git add README.md | |", "Skip"],
];

const STRUCTURED: readonly (readonly [string, Disposition])[] = [
  ["echo hi>&2", "Skip"],
  ["echo x 2>&1", "Skip"],
  ["cmd arg >& /dev/null", "Skip"],
  ["cmd >|f", "Skip"],
  // Heredoc bodies are data inside the opener's span, never segments.
  ["cat <<EOF\nrm -f /tmp/work\nEOF", "Skip"],
  ["cat <<'EOF'\n$(rm -rf /)\nEOF", "Skip"],
  ["cat <<-EOF\n x\n EOF", "Skip"],
  ["cat <<EOF", "Skip"],
  ["echo 1 <<str", "Skip"],
  // ANSI-C quoting decodes escapes, never runs substitutions.
  ["echo $'a\nb'", "Skip"],
  // Process substitution bodies expand like command substitutions.
  ["cat <(echo hi)", "Skip"],
  ["diff <(rm -rf /) <(echo y)", "NeedsApproval"],
  ["echo $(pwd)", "Skip"],
  ["echo $(rm -rf /)", "NeedsApproval"],
  ["$(=$(rm -rf /))", "NeedsApproval"],
  ["rm -rf $(echo /tmp/work) extra", "NeedsApproval"],
  // A bare assignment runs no program.
  ["FOO=1", "Skip"],
  ["FOO=$(whoami) bar", "Skip"],
  ["FOO=1; git push", "Skip"],
  ["export A=1", "Skip"],
  ["export A=1; git push", "Skip"],
  // Compound commands expand: the dangerous body inside still reviews.
  ["for i in 1; do rm -f /tmp/work; done", "NeedsApproval"],
  ["if true; then rm -f /tmp/work; fi", "NeedsApproval"],
  ["{ rm -f /tmp/work; }", "NeedsApproval"],
  ["(rm -f /tmp/work)", "NeedsApproval"],
  ["(rm -f /tmp/work) | cat", "NeedsApproval"],
  ["! rm -f /tmp/work", "NeedsApproval"],
  // `[`/`[[` are test builtins, never hidden executables.
  ["[ -f $x ]", "Skip"],
  ["[[ $x == 1 ]]", "Skip"],
  // Malformed input fails closed where the grammar cannot read it, and stays
  // quiet where the surviving command is harmless.
  ["echo hi >", "Skip"],
  ["echo $(", "NeedsApproval"],
  ["echo '", "Skip"],
  ['git push "', "Skip"],
  ["&&", "Skip"],
  [";", "Skip"],
  // A substitution inside a comment never runs.
  ["git push # $(evil)", "Skip"],
  // A line continuation joins before word-splitting: this is one `git add`
  // and one `git push`, not four words.
  ["git add A \\\n && git push", "Skip"],
];

/**
 * The nested-visibility corpus: commands where a segmentation change would
 * hide a dangerous argv, so each one is asserted to keep revealing it.
 * Heredoc bodies are deliberately absent: a body line is the command's input
 * data, not an argv any shell runs.
 */
const VISIBLE_PAYLOADS: readonly (readonly [string, string])[] = [
  ["$(rm -rf /)", "rm"],
  ["`rm -rf /`", "rm"],
  ["<(rm -rf /)", "rm"],
  ["bash -c 'rm -rf /'", "rm"],
  ["zsh -c 'rm -rf /'", "rm"],
  ["rm >'>' -rf /", "rm"],
  ["rm -- -rf /", "rm"],
  [">out rm -rf /", "rm"],
  ["echo $(rm -rf /)", "rm"],
  ["echo `rm -rf /`", "rm"],
];

async function ready(): Promise<NonNullable<ReturnType<typeof shellAstParser>>> {
  await ensureTreeSitterReady();
  const parser = shellAstParser();
  if (!parser) throw new Error(`bridge unavailable: ${JSON.stringify(treeSitterShellFailure())}`);
  return parser;
}

describe("sole shell interpreter verdicts", () => {
  it("says the pinned disposition for every everyday command", () => {
    for (const [command, disposition] of EVERYDAY) {
      expect(observe(command).disposition, JSON.stringify(command)).toBe(disposition);
    }
  });

  it("runs no syntax error, so every one Skips", () => {
    for (const [command, disposition] of SYNTAX_ERROR) {
      const seen = observe(command);
      expect(seen.disposition, JSON.stringify(command)).toBe(disposition);
      expect(
        seen.segments.some((segment) => segment.unprovenCause === "ast_unmodelled"),
        JSON.stringify(command),
      ).toBe(false);
    }
  });

  it("expands structure and keeps data data", () => {
    for (const [command, disposition] of STRUCTURED) {
      expect(observe(command).disposition, JSON.stringify(command)).toBe(disposition);
    }
  });

  it("keeps every dangerous argv a reviewer needs visible", () => {
    for (const [command, executable] of VISIBLE_PAYLOADS) {
      const segments = parseCommandSegments(command);
      expect(
        segments.some((segment) => segment.executable === executable),
        command,
      ).toBe(true);
    }
  });

  it("refuses to downgrade a dangerous command, however it is spelled", () => {
    const forbidden = [
      "rm -rf /",
      "rm -rf / --no-preserve-root",
      "$(rm -rf /)",
      "echo `rm -rf /`",
      "bash -c 'rm -rf /'",
      ">out rm -rf /",
      "rm >'>' -rf /",
    ];
    for (const command of forbidden) {
      expect(observe(command).disposition, command).toBe("NeedsApproval");
    }
  });

  it("fails closed on a substitution nest past the fold's depth bound", () => {
    // Nine substitutions deep, double-quoted: the bound stops expansion and
    // the host reviews on `expansion_bound` rather than Skipping past unseen
    // argv. The bound stops inspection, never the verdict.
    const command =
      'echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo hi)")")")")")")")")"';
    const seen = observe(command);
    expect(seen.disposition, command).toBe("NeedsApproval");
    expect(
      seen.segments.some((segment) => segment.unprovenCause === "expansion_bound"),
      command,
    ).toBe(true);
  });

  it("covers the whole corpus with no unjudged command", () => {
    const zones = new Set<string>([
      ...EVERYDAY.map(([command]) => command),
      ...SYNTAX_ERROR.map(([command]) => command),
      ...STRUCTURED.map(([command]) => command),
    ]);
    expect(zones.size).toBe(EVERYDAY.length + SYNTAX_ERROR.length + STRUCTURED.length);
    for (const command of zones) {
      expect(() => observe(command), command).not.toThrow();
      expect(observe(command).disposition, command).toMatch(/^(Skip|NeedsApproval|Forbidden)$/);
    }
  });
});

describe("shell AST adapter fidelity", () => {
  afterEach(() => {
    // This file never uninstalls except in the throw test below, which
    // restores inline; the hook is a backstop, not a state dance.
    if (!astFrontEndEngaged("echo ok")) {
      void ready().then((parser) => installShellAstParser(parser));
    }
  });

  /** The quoted-argv regressions: reading quoting wrong is a defect even when it is loud. */
  it("treats a single-quoted parameter expansion as inert argv", () => {
    // Shell semantics: single quotes never expand, so `'${FLAG:--S}'` is one
    // word. Double quotes *do* expand, and the front end must say so.
    const cases: readonly (readonly [string, boolean])[] = [
      ["git push '${FLAG:--S}'", false],
      ['git push "${FLAG:--S}"', true],
      ["echo 'a$(pwd)b'", false],
      ['echo "a$(pwd)b"', true],
    ];
    for (const [command, live] of cases) {
      const [segment] = parseCommandSegments(command);
      expect(segment?.hasSubstitution, command).toBe(live);
    }
  });

  it("honours an escaped dollar or backtick the way the shell does", () => {
    // The grammar leaves `a\$b` as one word whose text still contains the
    // backslash. A leaf-level scan for `$` reports it live; the shell passes
    // a literal `$` to `argv`.
    const cases: readonly (readonly [string, string[]])[] = [
      ["echo a\\$b", ["a$b"]],
      ["echo a\\`b", ["a`b"]],
    ];
    for (const [command, args] of cases) {
      const [segment] = parseCommandSegments(command);
      expect(segment?.hasSubstitution, command).toBe(false);
      expect(segment?.args, command).toEqual(args);
      expect(segment?.decomposable, command).toBe(true);
    }
  });

  it("reads a redirect as the file the shell writes, not as argv", () => {
    // The adapter's span is the whole statement, so the argv must come from the grammar's
    // own account of the operator: the first target is the file, the rest are arguments.
    const cases: readonly (readonly [string, string, string[]])[] = [
      ["ls > out", "ls", []],
      ["echo x > a > b", "echo", ["x"]],
      ["git > push origin", "git", ["origin"]],
      ["del >out", "del", []],
    ];
    for (const [command, executable, args] of cases) {
      const [segment] = parseCommandSegments(command);
      expect(segment?.source, command).toBe(command);
      expect(segment?.executable, command).toBe(executable);
      expect(segment?.args, command).toEqual(args);
      expect(segment?.hasRedirect, command).toBe(true);
    }
  });

  it("answers a dangling operator without failing closed", () => {
    // `del stuff &&` ends on a `&&` whose right-hand command never arrived.
    // The grammar recovers with an empty ERROR node that is a sibling of
    // the command — inside no statement's subtree — so the statement's text
    // was read cleanly. Contrast `rm -rf $(`, whose ERROR sits inside the
    // command with real text and reviews.
    const [segment] = parseCommandSegments("del stuff &&");
    expect(segment?.decomposable).toBe(true);
    expect(segment?.unprovenCause).toBeUndefined();
    expect(segment?.source).toBe("del stuff");
    expect(segment?.args).toEqual(["stuff"]);
  });

  it("keeps nested substitution bodies visible to the fold", () => {
    // A body the grammar names must be expanded, since dropping one hides
    // what runs. `echo "a$(pwd)b"` is the shape where the grammar names the
    // substitution precisely.
    for (const command of [
      'echo "a$(pwd)b"',
      "echo `pwd`",
      "FOO='$(pwd)' bar",
      'git commit "${FLAG:--S}" -m update',
    ]) {
      const segments = parseCommandSegments(command);
      expect(segments.length, command).toBeGreaterThan(0);
    }
    const [body] = parseCommandSegments('echo "a$(pwd)b"').slice(-1);
    expect(body?.executable).toBe("pwd");
  });

  it("leaves the verdict intact when the installed parser fails mid-session", async () => {
    // The bridge marks itself broken and drops the parser if a WASM call
    // traps, but the pure layer's slot still holds the object it was given.
    // A throwing parse fails that command closed (review), and the slot is
    // restored before this test ends so the file stays green.
    const before = observe("pwd");
    expect(before.disposition).toBe("Skip");
    installShellAstParser({
      parse(): never {
        throw new Error("wasm trap");
      },
    });
    try {
      const after = observe("pwd");
      expect(after.disposition).toBe("NeedsApproval");
      expect(after.segments.some((segment) => segment.unprovenCause === "ast_unmodelled")).toBe(
        true,
      );
    } finally {
      resetTreeSitterShellActivation();
      installShellAstParser(undefined);
      const parser = await ready();
      installShellAstParser(parser);
    }
    expect(observe("pwd").disposition).toBe("Skip");
  });

  it("answers for an empty command line with no segments", () => {
    for (const command of ["", "   "]) {
      expect(parseCommandSegments(command)).toEqual([]);
    }
  });
});

describe("tree-sitter parser always on", () => {
  afterEach(() => {
    resetTreeSitterShellActivation();
  });

  it("ignores the retired flag in every spelling", async () => {
    // The flag is retired: activation no longer consults the environment.
    // Any spelling — including an unset variable — leaves the interpreter on.
    for (const value of [undefined, "1", "0", "true", "", "yes", " 1", "1 "] as const) {
      resetTreeSitterShellActivation();
      const env = value === undefined ? {} : { PI_SAFETY_TREE_SITTER_PARSER: value };
      await expect(activateTreeSitterShellParser(env)).resolves.toBe(true);
      expect(shellAstParserInstalled()).toBe(true);
      expect(treeSitterShellFailure()).toBeUndefined();
    }
  });

  it("installs the grammar through the barrier", async () => {
    await expect(activateTreeSitterShellParser({})).resolves.toBe(true);
    expect(shellAstParserInstalled()).toBe(true);
    expect(treeSitterShellFailure()).toBeUndefined();
  });

  it("never rejects, however it is called", async () => {
    for (const value of ["0", "true", "", "1 "] as const) {
      await expect(
        activateTreeSitterShellParser({ PI_SAFETY_TREE_SITTER_PARSER: value }),
      ).resolves.toBe(true);
    }
  });

  it("memoizes the activation so the barrier costs one promise", async () => {
    await expect(activateTreeSitterShellParser({})).resolves.toBe(true);
    await expect(activateTreeSitterShellParser({})).resolves.toBe(true);
    expect(shellAstParserInstalled()).toBe(true);
    resetTreeSitterShellActivation();
    installShellAstParser(undefined);
    await expect(activateTreeSitterShellParser({})).resolves.toBe(true);
    expect(shellAstParserInstalled()).toBe(true);
  });
});
