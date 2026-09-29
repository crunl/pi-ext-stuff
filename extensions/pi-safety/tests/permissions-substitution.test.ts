import { describe, expect, it } from "vitest";
import { classifyRisk, normalizeToolCall, parseCommandSegments } from "../src/permissions/risk.ts";
import { scanShellSyntax } from "../src/permissions/shell-lexer.ts";

describe("live substitution extraction", () => {
  it("reports the body of every live substitution, inert ones none", () => {
    expect(scanShellSyntax("echo $(date)").liveSubstitutions).toEqual(["date"]);
    expect(scanShellSyntax('echo "$(date)"').liveSubstitutions).toEqual(["date"]);
    expect(scanShellSyntax("echo `date`").liveSubstitutions).toEqual(["date"]);
    // Inert spellings: single quotes and `\$` never run, and the parser must
    // not be handed bodies the shell will not.
    expect(scanShellSyntax("echo '$(date)'").liveSubstitutions).toEqual([]);
    expect(scanShellSyntax("echo \\$(date)").liveSubstitutions).toEqual([]);
    expect(scanShellSyntax("echo \\`date\\`").liveSubstitutions).toEqual([]);
    // Parameter expansion has no body to read — review stays its only exit.
    expect(scanShellSyntax("echo $HOME ${VAR:-x} $1").liveSubstitutions).toEqual([]);
  });

  it("pairs parentheses through quotes and nesting, and never past a mismatch", () => {
    // The outer body is paired with the inner quotes and parens respected.
    // The scan deliberately keeps walking the body text, so a nested
    // substitution the naive outer quote pairing also sees live is reported
    // as well: duplicates cost one extra parse and change no verdict —
    // every reported body is genuinely live under that pairing.
    expect(scanShellSyntax('echo "$(echo "$(date)")"').liveSubstitutions).toEqual([
      'echo "$(date)"',
      "date",
    ]);
    expect(scanShellSyntax('echo "$(echo ")")"').liveSubstitutions).toEqual(['echo ")"']);
    // A `)` inside single quotes is data, not the close of the substitution.
    expect(scanShellSyntax("echo $(echo ')')").liveSubstitutions).toEqual(["echo ')'"]);
    // Unclosed forms yield no body at all: the booleans already fail the
    // command closed, and half-matched text never reaches a parser.
    expect(scanShellSyntax("echo $(date").liveSubstitutions).toEqual([]);
    expect(scanShellSyntax("echo `date").liveSubstitutions).toEqual([]);
  });

  it("caps reported bodies without touching the booleans", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `$(echo ${i})`).join(" ");
    const syntax = scanShellSyntax(`echo ${nine}`);
    expect(syntax.liveSubstitutions).toHaveLength(8);
    expect(syntax.hasExecutableSubstitution).toBe(true);
  });

  it("feeds parsed bodies through the same trust inheritance as shell bodies", () => {
    const segments = parseCommandSegments('echo "$(git status)"');
    const git = segments.find((segment) => segment.executable === "git");
    expect(git?.nestedFrom).toBe("substitution");
    const shell = parseCommandSegments("bash -c 'git push origin main'");
    const pushed = shell.find((segment) => segment.executable === "git");
    expect(pushed?.nestedFrom).toBe("shell_body");
    // An untrusted host still taints the body through either source.
    const tainted = parseCommandSegments('env PATH=/tmp sh -c "echo $(git push origin main)"');
    const inner = tainted.filter((segment) => segment.executable === "git");
    expect(inner.length).toBeGreaterThan(0);
    for (const segment of inner) expect(segment.executableTrusted).toBe(false);
  });

  it("binds provenance to the construct that exposed the body", () => {
    // The substitution label wins for a segment exposed by a `$(…)` body that
    // itself spans a shell body — the review reason may name either.
    const segments = parseCommandSegments("echo \"$(bash -c 'rm -rf /')\"");
    const rm = segments.find((segment) => segment.executable === "rm");
    expect(rm?.nestedFrom).toBeDefined();
    expect(
      classifyRisk(
        normalizeToolCall("bash", { command: "echo \"$(bash -c 'rm -rf /')\"" }, "/work/repo"),
      ),
    ).toBe("Forbidden");
  });

  it("expands nested substitutions up to the bound and never opens a door past it", () => {
    const eight = (inner: string, depth: number): string =>
      depth === 0 ? inner : `echo "$(${eight(inner, depth - 1)})"`;
    // Within the bound the body surfaces and tier 1 sees the deletion.
    expect(
      classifyRisk(normalizeToolCall("bash", { command: eight("rm -rf /", 7) }, "/work/repo")),
    ).toBe("Forbidden");
    // Past the bound expansion stops; whether the word splitter has already
    // exposed the body is the splitter's accident, not this mechanism's
    // promise. What the cap must never do is reach the other side of review:
    // unbounded work on adversarial input, or a Skip.
    for (const depth of [12, 20]) {
      expect(
        classifyRisk(
          normalizeToolCall("bash", { command: eight("rm -rf /", depth) }, "/work/repo"),
        ),
      ).not.toBe("Skip");
    }
  });

  it("judges quoted and unquoted twins identically", () => {
    for (const command of [
      'echo "$(rm -rf /)"',
      "echo $(rm -rf /)",
      "echo `rm -rf /`",
      'echo "x" $(rm -rf /)',
    ]) {
      expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo")), command).toBe(
        "Forbidden",
      );
    }
    for (const command of ['echo "$(date)"', "echo $(date)", "echo `date`"]) {
      expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo")), command).toBe(
        "NeedsApproval",
      );
    }
  });
});
