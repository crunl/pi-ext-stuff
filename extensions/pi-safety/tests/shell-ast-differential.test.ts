/**
 * Differential proof for the Shell AST migration (phase 1).
 *
 * The migration's contract is not "the grammar reads shell better". It is that the AST
 * front end is **never looser** than the hand-written lexer: no forbidden command becomes
 * a review, no reviewed command becomes an auto-run, no argv that revealed a deletion or
 * a network target stops being visible, and no nested substitution loses its record.
 *
 * The suite runs the same corpus through both front ends in one process, by installing
 * and uninstalling the parser — the seam the host bridge uses — and compares. The
 * comparison is deliberately asymmetric: relaxation in any field fails, a *tightening*
 * is allowed and reported, because the grammar knowing more than the lexer is the reason
 * to do this migration at all.
 *
 * Three zones, so a failure says where the model is wrong:
 *  - `EQUIVALENT`: byte-for-byte identical segments and disposition. The lexer already
 *    read these correctly, and the AST must not disturb them.
 *  - `STRICTER`: the AST fails closed where the lexer was satisfied. Allowed, listed.
 *  - `OUT_OF_MODEL`: the AST abstains and the shipped path answers untouched. Proven by
 *    equality, not by hope: these commands must not change at all.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  classifyRiskWithCause,
  deletionTargets,
  normalizeToolCall,
  parseCommandSegments,
} from "../src/permissions/risk.ts";
import type { CommandSegment } from "../src/permissions/rules.ts";
import {
  analyzeCommandWithAst,
  installShellAstParser,
  type SegmentFacts,
  shellAstParserInstalled,
} from "../src/permissions/shell-ast.ts";
import { splitShellSegments } from "../src/permissions/shell-lexer.ts";
import { astFrontEndEngaged } from "../src/permissions/shell-segment.ts";
import {
  activateTreeSitterShellParser,
  ensureTreeSitterReady,
  resetTreeSitterShellActivation,
  shellAstParser,
  TREE_SITTER_PARSER_ENV_FLAG,
  treeSitterParserEnabled,
  treeSitterShellFailure,
} from "../src/tree-sitter/shell-backend.ts";

/** Tier ordering: a lower number is a quieter verdict, so any drop is a relaxation. */
const DISPOSITION_TIER = { Skip: 0, NeedsApproval: 1, Forbidden: 2 } as const;

interface Observation {
  segments: CommandSegment[];
  disposition: "Skip" | "NeedsApproval" | "Forbidden";
  cause: string | null;
  substitution: string | null;
  targets: string[];
}

/**
 * Everything the review path derives from one command, with the AST front end either
 * installed or not.
 *
 * `networkApproved` is true so a network subcommand reaches the tier that reads the
 * substitution facts instead of being refused by the network rule first; the deletion
 * targets are collected per segment because that is where argv visibility is lost.
 */
function observe(command: string): Observation {
  const segments = parseCommandSegments(command);
  const request = normalizeToolCall("bash", { command }, "/work/repo");
  const review = classifyRiskWithCause(request, true);
  return {
    segments,
    disposition: review.disposition,
    cause: "cause" in review ? String(review.cause) : null,
    substitution: "dangerousSubstitution" in review ? String(review.dangerousSubstitution) : null,
    targets: segments.flatMap((segment) => deletionTargets(segment)),
  };
}

/**
 * Every relaxation this phase is not allowed to produce, as a list of reasons.
 *
 * Checked against the shipped path's own output rather than against a table of expected
 * verdicts, so the corpus does not need maintaining when a rule changes: the lexer is the
 * specification, and this is the only way a new rule cannot quietly arrive wearing the
 * AST.
 */
function relaxations(before: Observation, after: Observation): string[] {
  const problems: string[] = [];
  if (DISPOSITION_TIER[after.disposition] < DISPOSITION_TIER[before.disposition]) {
    problems.push(`disposition ${before.disposition} -> ${after.disposition}`);
  }
  if (before.substitution !== null && after.substitution === null) {
    problems.push("dangerous substitution lost");
  }
  for (const target of before.targets) {
    if (!after.targets.includes(target)) problems.push(`deletion target lost: ${target}`);
  }
  if (after.segments.length < before.segments.length) {
    problems.push(`segment count ${before.segments.length} -> ${after.segments.length}`);
  }
  const shared = Math.min(before.segments.length, after.segments.length);
  for (let index = 0; index < shared; index++) {
    const left = before.segments[index];
    const right = after.segments[index];
    if (!left || !right) continue;
    const where = `segment ${index} (${JSON.stringify(left.source)})`;
    if (left.source !== right.source) problems.push(`${where} span moved`);
    if (left.executable !== right.executable) {
      problems.push(`${where} executable ${left.executable} -> ${right.executable}`);
    }
    if (left.executableToken !== right.executableToken) {
      problems.push(`${where} executable token moved`);
    }
    if (JSON.stringify(left.args) !== JSON.stringify(right.args)) {
      problems.push(`${where} argv ${JSON.stringify(left.args)} -> ${JSON.stringify(right.args)}`);
    }
    // The one field allowed to move in this direction only.
    if (!left.decomposable && right.decomposable) {
      problems.push(`${where} became decomposable from ${left.unprovenCause ?? "unproven"}`);
    }
    if (left.hasSubstitution && !right.hasSubstitution) {
      problems.push(`${where} lost its substitution flag`);
    }
    if (left.hasRedirect && !right.hasRedirect) problems.push(`${where} lost its redirect flag`);
    if (left.nestedShell && !right.nestedShell) problems.push(`${where} lost nestedShell`);
    if (left.nestedFrom && !right.nestedFrom) problems.push(`${where} lost nested provenance`);
    if (!left.executableTrusted && right.executableTrusted) {
      problems.push(`${where} became a trusted program`);
    }
    if (!left.executableContextUntrusted && right.executableContextUntrusted) {
      problems.push(`${where} gained an untrusted context`);
    }
    if (left.executableContextUntrusted && !right.executableContextUntrusted) {
      // An untrusted *context* is a review: the grammar must not argue away a `GIT_`
      // variable or an unreduced wrapper that the shipped path could not settle.
      problems.push(`${where} lost its untrusted context`);
    }
  }
  return problems;
}

/** Whether the AST front end answered for this command, on production's own gate. */
function astEngaged(command: string): boolean {
  return astFrontEndEngaged(command);
}

/**
 * Commands the lexer already reads exactly, so the AST must be silent about them:
 * same spans, same argv, same verdict. Quoting, pipelines, boolean chains and redirects
 * that the character splitter happens to cut correctly.
 */
const EQUIVALENT: readonly string[] = [
  "git push origin main",
  "git status",
  "ls -la",
  "echo hi",
  "npm install lodash",
  "cat notes.txt | head -5",
  "git status && ls",
  "git add A.md && git commit -m x && git push",
  // Dangling operators: tree-sitter recovers a single trailing `&&`, `||`
  // or `|` (and a leading `;` or `|`) with an empty-span ERROR node that
  // is a sibling of the command — inside no statement's subtree — so the
  // statements they frame are whole and the front end answers exactly the
  // way the lexer does. Contrast `rm -rf $(` below, whose ERROR sits
  // inside the command with real text, and STRICTER's `|;` / `| |`, where
  // the grammar gives up on the composition and wraps the whole line.
  "; git add README.md",
  "| git add README.md",
  "git add README.md |",
  "git add README.md;",
  "git add README.md &",
  "git add README.md &&",
  "git add README.md ||",
  "a && b &&",
  "rm -f /tmp/work |",
  "rm -f /tmp/work &&",
  "ls | wc -l",
  "true && :",
  "git commit -m 'fix bug'",
  'git commit -m "fix bug"',
  "rm -f build/output.txt",
  "rm -f 'a b'",
  'rm -f "a b"',
  'echo ""',
  "echo ''",
  "echo ''\"\"$x",
  "rm foo\\ bar",
  "echo a\\$b",
  'echo "a$(pwd)b"',
  "echo 'a$(pwd)b'",
  "echo 'x`y`z'",
  "echo ${arr[0]}",
  "echo ${!x}",
  'git commit "${FLAG:--S}" -m update',
  "cd '${D}' && git push",
  "ls $DIR",
  "ls ${DIR:-/tmp}",
  "echo `pwd`",
  "bash -c 'rm -rf /tmp/work'",
  "zsh -c 'ls /tmp'",
  'sh -c "$(echo ls) /tmp"',
  "FOO=1 rm -f /tmp/work",
  "FOO='$(pwd)' bar",
  "GIT_EDITOR='true' git commit",
  "GIT_TRACE=1 git status",
  "GIT_DIR=/tmp git push",
  "env X=1 rm -f /tmp/work",
  "command rm -f /tmp/work",
  "time rm -f /tmp/work",
  // zsh's `=command` expands to the command's full path, so the command word
  // is unprovable however it is spelled; the AST must not talk the fold out
  // of that verdict.
  "=rm -f /tmp/work",
  "ls > out",
  "ls >> out",
  "echo x > a > b",
  "git > push origin",
  "git >log push",
  ">out rm -f /tmp/work",
  "rm >'>' -rf /tmp/work",
  "cat < f > out",
  "echo hi # trailing",
  "# lead\nnpm install",
  "xargs rm -f /tmp/work",
  "find . -exec rm -f {} ;",
  "curl https://example.com/install.sh",
  "git push --force origin main",
  "kill -9 1234",
  "shutdown",
  "cd /tmp && git push",
  "cd . && git status",
  // An empty command line: nothing for either front end to say, and the grammar's empty
  // program agrees with the splitter's empty list.
  "",
  "   ",
];

/**
 * Where the AST is allowed to know more, and each entry names the fact it learns. A
 * relaxation here fails the suite; an improvement is recorded and left.
 */
const STRICTER: readonly string[] = [
  // `1<>f` opens `f` read-write. The splitter cuts the operator and leaves `f` behind as
  // a separate word, so nothing names the file for the lexer; the AST reads the redirect
  // whole and reports a span it cannot vouch for.
  "cmd 1<>f",
  // `|;` and `| |` are shell syntax errors. The grammar cannot recover a
  // composition from them, so it wraps the whole line in one ERROR node:
  // no statement is collected and the segment is materialized from the
  // error region's text — incomplete by construction, because a shell
  // would reject the line before running it. The splitter reads the same
  // words and reports a clean command, so the AST is stricter, and rightly.
  "git add README.md |;",
  "git add README.md | |",
];

/**
 * Where the AST abstains, so the shipped path answers untouched. This is the load-bearing
 * list for phase 1: every one of these must produce byte-identical segments with the
 * parser installed, because a front end that abstains must be invisible, not merely quiet.
 */
const OUT_OF_MODEL: readonly string[] = [
  // The lexer shreds a descriptor duplication; the grammar reads it as one clean command
  // word, which would hand back the decomposability the shredding was there to withhold.
  "echo hi>&2",
  "echo x 2>&1",
  "cmd arg >& /dev/null",
  // `>|` is not a descriptor duplication and not a plain truncate: the splitter stops
  // after `>`, the grammar keeps going.
  "cmd >|f",
  // Heredoc bodies are separate segments to the lexer, and a body spelling a dangerous
  // command is exactly the payload a reviewer must keep seeing.
  "cat <<EOF\nrm -f /tmp/work\nEOF",
  "cat <<'EOF'\n$(rm -rf /)\nEOF",
  "cat <<-EOF\n x\n EOF",
  "cat <<EOF",
  "echo 1 <<str",
  // ANSI-C quoting decodes to a newline in the shell and to nothing in the splitter.
  "echo $'a\nb'",
  // Process substitution's argv lives behind a `<(` the splitter cannot pair.
  "cat <(echo hi)",
  "diff <(rm -rf /) <(echo y)",
  // A `$(` the splitter shreds into `$` + `(`, which is where nested-body visibility
  // comes from today.
  "echo $(pwd)",
  "echo $(rm -rf /)",
  "$(=$(rm -rf /))",
  "echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo hi)))))))",
  // The same nest one level past the fold's MAX_SUBSTITUTION_NESTING bound:
  // nine substitutions deep. The splitter shreds the outer `$(`, so the front
  // end abstains and both paths answer with the same unproven command words.
  "echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo hi)))))))))",
  // The same nine-level nest behind double quotes, so the splitter keeps every
  // level's text whole enough to name a live substitution: each shredded span
  // answers `substitution_unproven` rather than trusting the argv it read.
  'echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo hi)")")")")")")")")")"',
  "rm -rf $(echo /tmp/work) extra",
  // A bare assignment is a statement of its own to the grammar, and a wordless nameless
  // segment to the lexer; the two do not cut the same span.
  "FOO=1",
  "FOO=$(whoami) bar",
  "FOO=1; git push",
  "export A=1",
  "export A=1; git push",
  // Compound commands, control flow, and tests are phase-2 territory.
  "for i in 1; do rm -f /tmp/work; done",
  "if true; then rm -f /tmp/work; fi",
  "{ rm -f /tmp/work; }",
  "(rm -f /tmp/work)",
  "(rm -f /tmp/work) | cat",
  "rm -f /tmp/work; (rm -f /tmp/work)",
  "! rm -f /tmp/work",
  "[ -f $x ]",
  "[[ $x == 1 ]]",
  // Malformed input: the splitter's own fail-closed shape must survive untouched.
  "echo hi >",
  "echo $(",
  "echo '",
  'git push "',
  "&&",
  ";",
  // A comment carrying an expansion: the grammar attaches it to the statement, the
  // splitter starts a new one.
  "git push # $(evil)",
  // A line continuation joins `rm` and `m` for the shell and nothing for the grammar.
  "git add A \\\n && git push",
];

/**
 * The nested-visibility corpus. Not a zone: these are the commands where a segmentation
 * change would hide a dangerous argv, so each one is asserted to keep revealing it.
 * Heredoc bodies are deliberately absent: a body line is the command's input
 * data, not an argv any shell runs, so "revealing" one was the false positive
 * the heredoc-aware splitter removed. The heredoc corpus that pins the new
 * behaviour lives in permissions-substitution.test.ts.
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

describe("shell AST differential (phase 1)", () => {
  let parser: Awaited<ReturnType<typeof ready>>;

  beforeAll(async () => {
    parser = await ready();
  });

  it("starts and ends with no front end installed, so the default path is V1", () => {
    installShellAstParser(undefined);
    expect(shellAstParserInstalled()).toBe(false);
  });

  it("keeps the AST out of every segment field in the equivalent zone", () => {
    for (const command of EQUIVALENT) {
      installShellAstParser(parser);
      const engaged = astEngaged(command);
      installShellAstParser(undefined);
      expect(engaged, command).toBe(true);
      const before = observe(command);
      installShellAstParser(parser);
      const after = observe(command);
      installShellAstParser(undefined);
      expect(relaxations(before, after), command).toEqual([]);
      // This zone's claim is stronger than "not looser": identical, field by field.
      expect(
        after.segments.map((segment) => [
          segment.source,
          segment.executable,
          segment.args,
          segment.decomposable,
          segment.unprovenCause ?? null,
          segment.hasRedirect,
          segment.hasSubstitution,
          segment.nestedFrom ?? null,
        ]),
        command,
      ).toEqual(
        before.segments.map((segment) => [
          segment.source,
          segment.executable,
          segment.args,
          segment.decomposable,
          segment.unprovenCause ?? null,
          segment.hasRedirect,
          segment.hasSubstitution,
          segment.nestedFrom ?? null,
        ]),
      );
      expect(after.disposition, command).toBe(before.disposition);
      expect(after.cause, command).toBe(before.cause);
    }
    installShellAstParser(undefined);
  });

  it("diverges only by becoming stricter in the grammar-correction zone", () => {
    installShellAstParser(undefined);
    for (const command of STRICTER) {
      installShellAstParser(parser);
      const engaged = astEngaged(command);
      installShellAstParser(undefined);
      expect(engaged, command).toBe(true);
      const before = observe(command);
      installShellAstParser(parser);
      const after = observe(command);
      installShellAstParser(undefined);
      expect(relaxations(before, after), command).toEqual([]);
      expect(JSON.stringify(after) === JSON.stringify(before), command).toBe(false);
    }
    installShellAstParser(undefined);
  });

  it("leaves the shipped path byte-identical wherever the AST abstains", () => {
    for (const command of OUT_OF_MODEL) {
      installShellAstParser(parser);
      const engaged = astEngaged(command);
      installShellAstParser(undefined);
      expect(engaged, command).toBe(false);
      const before = observe(command);
      installShellAstParser(parser);
      const after = observe(command);
      installShellAstParser(undefined);
      expect(
        after.segments.map((segment) => [
          segment.source,
          segment.executable,
          segment.args,
          segment.decomposable,
          segment.unprovenCause ?? null,
        ]),
        command,
      ).toEqual(
        before.segments.map((segment) => [
          segment.source,
          segment.executable,
          segment.args,
          segment.decomposable,
          segment.unprovenCause ?? null,
        ]),
      );
      expect(after.disposition, command).toBe(before.disposition);
    }
    installShellAstParser(undefined);
  });

  it("keeps every dangerous argv a reviewer needs visible on both paths", () => {
    for (const [command, executable] of VISIBLE_PAYLOADS) {
      for (const enabled of [false, true]) {
        installShellAstParser(enabled ? parser : undefined);
        const segments = parseCommandSegments(command);
        expect(
          segments.some((segment) => segment.executable === executable),
          `${command} with parser ${enabled}`,
        ).toBe(true);
      }
      installShellAstParser(undefined);
    }
  });

  it("refuses to downgrade a forbidden command, however it is spelled", () => {
    const forbidden = [
      "rm -rf /",
      "rm -rf / --no-preserve-root",
      "$(rm -rf /)",
      "echo `rm -rf /`",
      "bash -c 'rm -rf /'",
      ">out rm -rf /",
      "rm >'>' -rf /",
    ];
    installShellAstParser(undefined);
    for (const command of forbidden) {
      const before = observe(command);
      expect(before.disposition, command).toBe("Forbidden");
      installShellAstParser(parser);
      const after = observe(command);
      installShellAstParser(undefined);
      expect(relaxations(before, after), command).toEqual([]);
      expect(after.disposition, command).toBe("Forbidden");
    }
    installShellAstParser(undefined);
  });

  it("never lets the AST invent a span the splitter did not cut", () => {
    // A segmentation that differs from the lexer's is the mechanism by which argv moves
    // between commands, and `git push && echo hi>&2` is the shape where the grammar reads
    // two clean statements while the splitter shreds the second.
    installShellAstParser(parser);
    for (const command of [
      "git push && echo hi>&2",
      "ls > out; echo x 2>&1",
      "cat <<EOF\nrm -rf /\nEOF && git push",
      "FOO=1 && rm -rf /",
    ]) {
      const engaged = astEngaged(command);
      if (!engaged) continue;
      const analysis = analyzeCommandWithAst(command);
      const facts: SegmentFacts[] = analysis?.segments ?? [];
      expect(
        facts.map((fact) => fact.source),
        command,
      ).toEqual(splitShellSegments(command));
    }
    installShellAstParser(undefined);
  });

  it("leaves the shipped verdicts intact when the installed parser fails mid-session", () => {
    // The bridge marks itself broken and drops the parser if a WASM call traps, but the
    // pure layer's slot still holds the object it was given. So the slot's own behaviour
    // on a throwing parse is the last line of this phase: every command must fall back to
    // exactly what the lexer said before the migration, not to a blank answer.
    installShellAstParser(undefined);
    const baseline = [...EQUIVALENT, ...STRICTER, ...OUT_OF_MODEL].map(observe);
    installShellAstParser({
      parse(): never {
        throw new Error("wasm trap");
      },
    });
    const after = [...EQUIVALENT, ...STRICTER, ...OUT_OF_MODEL].map(observe);
    installShellAstParser(undefined);
    expect(after.map((observation) => observation.disposition)).toEqual(
      baseline.map((observation) => observation.disposition),
    );
    expect(after.map((observation) => observation.cause)).toEqual(
      baseline.map((observation) => observation.cause),
    );
  });

  it("answers for an empty command line on both paths", () => {
    // The grammar's empty `program` agrees with the splitter's empty list, so this is the
    // one shape where both front ends run and must say the same nothing.
    for (const command of ["", "   "]) {
      installShellAstParser(undefined);
      const before = parseCommandSegments(command);
      installShellAstParser(parser);
      const after = parseCommandSegments(command);
      installShellAstParser(undefined);
      expect(after).toEqual(before);
      expect(after).toEqual([]);
    }
  });

  it("fails closed on a substitution nest past the fold's depth bound", () => {
    // Nine substitutions deep, double-quoted so the splitter keeps every
    // level's text whole enough to name a live substitution: each shredded
    // span answers `substitution_unproven` instead of trusting the argv it
    // read. The line shreds into more spans than the grammar's single
    // statement, so the front end abstains and both paths must answer
    // byte-identically — the bound stops expansion, never the verdict.
    const command =
      'echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo hi)")")")")")")")")")"';
    installShellAstParser(undefined);
    const before = parseCommandSegments(command);
    installShellAstParser(parser);
    const after = parseCommandSegments(command);
    installShellAstParser(undefined);
    expect(after, command).toEqual(before);
    expect(
      before.some((segment) => segment.unprovenCause === "substitution_unproven"),
      command,
    ).toBe(true);
    expect(
      before.some((segment) => !segment.decomposable),
      command,
    ).toBe(true);
  });

  it("covers the whole corpus with no unclassified command", () => {
    const zones = new Set<string>([...EQUIVALENT, ...STRICTER, ...OUT_OF_MODEL]);
    expect(zones.size).toBe(EQUIVALENT.length + STRICTER.length + OUT_OF_MODEL.length);
    for (const command of zones) {
      installShellAstParser(undefined);
      const baseline = observe(command);
      installShellAstParser(parser);
      const ast = observe(command);
      const engaged = astEngaged(command);
      installShellAstParser(undefined);
      // Zone membership is derived from what the front end actually did, so a command
      // that quietly starts or stops agreeing with the lexer has to be reclassified
      // rather than pass unseen in the wrong list.
      if (!engaged) expect(OUT_OF_MODEL.includes(command), command).toBe(true);
      if (OUT_OF_MODEL.includes(command)) expect(engaged, command).toBe(false);
      if (EQUIVALENT.includes(command)) expect(engaged, command).toBe(true);
      expect(relaxations(baseline, ast), command).toEqual([]);
    }
    installShellAstParser(undefined);
  });
});

describe("shell AST adapter fidelity", () => {
  let parser: Awaited<ReturnType<typeof ready>>;

  beforeAll(async () => {
    parser = await ready();
  });

  afterEach(() => {
    installShellAstParser(undefined);
  });

  /** The quoted-argv regressions: reading quoting wrong is a defect even when it is loud. */
  it("treats a single-quoted parameter expansion as inert argv", () => {
    // Shell semantics and the shipped lexer both agree: single quotes never expand, so
    // `'${FLAG:--S}'` is one word. An early version of the adapter re-read its parent's raw
    // text, saw the `$`, and reported a live substitution — turning an auto-run into a
    // review on a false positive. Double quotes *do* expand, and both front ends must say so.
    const cases: readonly (readonly [string, boolean])[] = [
      ["git push '${FLAG:--S}'", false],
      ['git push "${FLAG:--S}"', true],
      ["echo 'a$(pwd)b'", false],
      ['echo "a$(pwd)b"', true],
    ];
    for (const [command, live] of cases) {
      installShellAstParser(undefined);
      const lexer = parseCommandSegments(command)[0];
      installShellAstParser(parser);
      const ast = parseCommandSegments(command)[0];
      expect(ast?.hasSubstitution, command).toBe(live);
      // The adapter follows the lexer here rather than outranking it.
      expect(ast?.hasSubstitution, command).toBe(lexer?.hasSubstitution);
      expect(ast?.decomposable, command).toBe(lexer?.decomposable);
    }
    installShellAstParser(undefined);
  });

  it("honours an escaped dollar or backtick the way the lexer does", () => {
    // The grammar leaves `a\$b` as one word whose text still contains the backslash. A
    // leaf-level scan for `$` reports it live; the shell passes a literal `$` to `argv`.
    const cases: readonly (readonly [string, string[]])[] = [
      ["echo a\\$b", ["a$b"]],
      ["echo a\\`b", ["a`b"]],
    ];
    for (const [command, args] of cases) {
      installShellAstParser(undefined);
      const lexer = parseCommandSegments(command)[0];
      installShellAstParser(parser);
      const ast = parseCommandSegments(command)[0];
      expect(ast?.hasSubstitution, command).toBe(false);
      expect(ast?.hasSubstitution, command).toBe(lexer?.hasSubstitution);
      expect(ast?.args, command).toEqual(args);
      expect(ast?.decomposable, command).toBe(true);
    }
    installShellAstParser(undefined);
  });

  it("reads a redirect as the file the shell writes, not as argv", () => {
    // The adapter's span is the whole statement, so the argv must come from the grammar's
    // own account of the operator: the first target is the file, the rest are arguments.
    installShellAstParser(parser);
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

  it("answers a dangling operator the way the lexer does", () => {
    // `del stuff &&` ends on a `&&` whose right-hand command never arrived.
    // The grammar recovers with an empty ERROR node that is a sibling of
    // the command — inside no statement's subtree — so the statement's text
    // was read cleanly and the fold does not fail closed. Both front ends
    // must answer exactly what the shipped lexer answers; contrast
    // `rm -rf $(`, whose ERROR sits inside the command with real text.
    // Asserted by name so a future change here is a decision, not an accident.
    installShellAstParser(undefined);
    const before = parseCommandSegments("del stuff &&");
    expect(before[0]?.decomposable).toBe(true);
    installShellAstParser(parser);
    const after = parseCommandSegments("del stuff &&");
    expect(after[0]?.decomposable).toBe(true);
    expect(after[0]?.unprovenCause).toBeUndefined();
    expect(after[0]?.source).toBe("del stuff");
    expect(after[0]?.args).toEqual(["stuff"]);
    expect(after).toEqual(before);
  });

  it("keeps nested substitution bodies visible to the fold on both front ends", () => {
    // A body either front end saw must be expanded, since dropping one hides what runs.
    // `echo "a$(pwd)b"` is the shape where the grammar names the substitution precisely and
    // the lexer approximates it by scanning.
    for (const command of [
      'echo "a$(pwd)b"',
      "echo `pwd`",
      "FOO='$(pwd)' bar",
      'git commit "${FLAG:--S}" -m update',
    ]) {
      installShellAstParser(undefined);
      const before = parseCommandSegments(command);
      installShellAstParser(parser);
      const after = parseCommandSegments(command);
      expect(
        after.map((segment) => segment.executable),
        command,
      ).toEqual(before.map((segment) => segment.executable));
      expect(after.length, command).toBeGreaterThanOrEqual(before.length);
    }
    installShellAstParser(undefined);
  });
});

describe("tree-sitter parser activation flag", () => {
  afterEach(() => {
    installShellAstParser(undefined);
    resetTreeSitterShellActivation();
  });

  it("is off unless the environment says exactly `1`", () => {
    expect(TREE_SITTER_PARSER_ENV_FLAG).toBe("PI_SAFETY_TREE_SITTER_PARSER");
    expect(treeSitterParserEnabled({})).toBe(false);
    for (const value of ["1", "0", "true", "", "yes", " 1"] as const) {
      expect(
        treeSitterParserEnabled({ [TREE_SITTER_PARSER_ENV_FLAG]: value }),
        JSON.stringify(value),
      ).toBe(value === "1");
    }
  });

  it("installs nothing and answers false while the flag is unset", async () => {
    // The shipped default: not one byte of WASM is read, and the pure layer never learns
    // the migration exists.
    await expect(activateTreeSitterShellParser({})).resolves.toBe(false);
    expect(shellAstParserInstalled()).toBe(false);
  });

  it("installs the grammar when the flag is on", async () => {
    await expect(
      activateTreeSitterShellParser({ [TREE_SITTER_PARSER_ENV_FLAG]: "1" }),
    ).resolves.toBe(true);
    expect(shellAstParserInstalled()).toBe(true);
    expect(treeSitterShellFailure()).toBeUndefined();
  });

  it("never rejects, however the flag is spelled", async () => {
    // A malformed or partial environment must not take down a request: the barrier is
    // awaited on the permission path, so activation reports instead of throwing.
    for (const value of ["0", "true", "", "yes", " 1", "1 "] as const) {
      const env = { [TREE_SITTER_PARSER_ENV_FLAG]: value };
      await expect(activateTreeSitterShellParser(env), JSON.stringify(value)).resolves.toBe(false);
      expect(shellAstParserInstalled(), JSON.stringify(value)).toBe(false);
    }
  });

  it("memoizes the activation so the barrier costs one promise", async () => {
    const env = { [TREE_SITTER_PARSER_ENV_FLAG]: "1" };
    await expect(activateTreeSitterShellParser(env)).resolves.toBe(true);
    // A later call with the flag removed still reports the activation that already
    // happened: the host reads the environment once per process, so the install is sticky
    // rather than flapping between front ends mid-session.
    await expect(activateTreeSitterShellParser({})).resolves.toBe(false);
    expect(shellAstParserInstalled()).toBe(true);
    resetTreeSitterShellActivation();
    installShellAstParser(undefined);
    await expect(activateTreeSitterShellParser({})).resolves.toBe(false);
    expect(shellAstParserInstalled()).toBe(false);
  });
});
