import { describe, expect, it } from "vitest";
import {
  classifyRisk,
  classifyRiskWithCause,
  normalizeToolCall,
  parseCommandSegments,
  type RiskClassification,
} from "../src/permissions/risk.ts";
import {
  scanShellSyntax,
  skippedHeredocSubstitutions,
  splitShellSegments,
  splitShellText,
} from "../src/permissions/shell-lexer.ts";

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
    ).toBe("NeedsApproval");
  });

  it("expands nested substitutions up to the bound and never opens a door past it", () => {
    const eight = (inner: string, depth: number): string =>
      depth === 0 ? inner : `echo "$(${eight(inner, depth - 1)})"`;
    // Within the bound the body surfaces and tier 1 sees the deletion.
    expect(
      classifyRisk(normalizeToolCall("bash", { command: eight("rm -rf /", 7) }, "/work/repo")),
    ).toBe("NeedsApproval");
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
        "NeedsApproval",
      );
    }
    for (const command of ['echo "$(date)"', "echo $(date)", "echo `date`"]) {
      expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo")), command).toBe(
        "NeedsApproval",
      );
    }
  });
});

describe("inert heredoc bodies", () => {
  it("reads a quoted-delimiter body as literal text, not shell code", () => {
    for (const opener of ["<<'EOF'", '<<"EOF"', "<<\\EOF"]) {
      const syntax = scanShellSyntax(`cat ${opener}\n$(date) ; more\nEOF`);
      expect(syntax.hasExecutableSubstitution, opener).toBe(false);
      expect(syntax.liveSubstitutions, opener).toEqual([]);
      // The mechanism marker stays — it is how the fold names the heredoc —
      // and the newline that ends the command line is a real control
      // character. Only the body's own content raises nothing.
      expect(syntax.hasHereDocument, opener).toBe(true);
      expect(syntax.hasActiveControl, opener).toBe(true);
    }
  });

  it("keeps an unquoted-delimiter body live, because bash expands it", () => {
    const syntax = scanShellSyntax("cat <<EOF\n$(date)\nEOF");
    expect(syntax.hasExecutableSubstitution).toBe(true);
    expect(syntax.liveSubstitutions).toEqual(["date"]);
  });

  it("delimits the body by a line equal to the delimiter", () => {
    // `EOFx` is data, so the substitution below it is still inside the body.
    expect(scanShellSyntax("cat <<'EOF'\nEOFx\n$(date)\nEOF").liveSubstitutions).toEqual([]);
    // What follows the redirect on its own line is a live command line.
    expect(scanShellSyntax("cat <<'EOF' | $(date)\nEOF").liveSubstitutions).toEqual(["date"]);
    // Two heredocs on one line queue their bodies on consecutive lines.
    expect(scanShellSyntax("cat <<'A' <<'B'\nx\nA\n$(date)\nB").liveSubstitutions).toEqual([]);
  });

  it("does not invent heredocs where bash sees none", () => {
    // Process substitution with a spaced redirect: not `<<`, and declaring
    // the `(…)` an inert body would be a fail-open.
    expect(scanShellSyntax("cat < <(echo hi)").hasHereDocument).toBe(false);
    // A `<<` inside double quotes is literal text.
    expect(scanShellSyntax(`echo "a <<'b'\nc\nEOF"`).hasHereDocument).toBe(false);
    // A here-string feeds one expanding word, not a body: its substitution
    // stays live, exactly as the shell expands it.
    expect(scanShellSyntax('wc <<< "$(date)"').liveSubstitutions).toEqual(["date"]);
  });

  it("names no heredoc cause for a quoted-delimiter body", () => {
    // A quoted delimiter is inert: the body is literal text, so the
    // command stays decomposable and no tier-4b cause fires. The
    // dangerous-looking body substitution is inert, so there is no
    // substitution cause either.
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "cat <<'EOF'\n$(date)\nEOF" }, "/work/repo"),
    );
    expect(review).toEqual({ disposition: "Skip" });
  });

  it("still inspects an unquoted body, because the shell runs it", () => {
    // The body's substitution is live shell source: the body is data
    // the segmenter must not cut into commands, but an unquoted
    // delimiter means the shell runs every substitution in it (measured
    // in real bash: the payload executes). The body's substitution is
    // therefore handed to the segment that opened the heredoc, and the
    // forced deletion it would run is tier 1's to refuse — the same
    // verdict the inline spelling earns, and the same one the codex
    // truth table returns (ForcedRm).
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "cat <<EOF\n$(rm -rf /)\nEOF" }, "/w/r"),
    );
    expect(review).toEqual({
      disposition: "NeedsApproval",
      dangerousSubstitution: "rm -rf /",
    });
  });

  it("routes a nested side-effecting body through tier 2", () => {
    // The inner `pkill` becomes an ordinary segment, so the process-control
    // review catches it even though the outer `echo` is harmless.
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "echo $(pkill x)" }, "/work/repo"),
    );
    expect(review).toEqual({ disposition: "NeedsApproval", cause: "process_control" });
  });
});

describe("active heredoc body substitutions", () => {
  // Real bash runs every substitution in an unquoted-delimiter body —
  // measured: the payload below executes and deletes its target — and
  // the codex truth table classifies the command as dangerous
  // (ForcedRm), the same verdict the inline spelling earns. The
  // splitter keeps body lines out of the segment list (they are
  // data), so a body's substitutions reach the danger check through
  // the segment that opened the heredoc, exactly as an inline
  // substitution's body does.
  it("refuses a forced deletion spelled in an active body", () => {
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "cat <<EOF\n$(rm -rf /tmp/work)\nEOF" }, "/w/r"),
    );
    expect(review).toEqual({
      disposition: "NeedsApproval",
      dangerousSubstitution: "rm -rf /tmp/work",
    });
  });

  it("refuses a forced deletion in an unterminated active body", () => {
    // An unterminated body runs to the end of the input, so the
    // substitution in it is still live shell source.
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "cat <<EOF\n$(rm -rf /tmp/work)" }, "/w/r"),
    );
    expect(review).toEqual({
      disposition: "NeedsApproval",
      dangerousSubstitution: "rm -rf /tmp/work",
    });
  });

  it("leaves an inert body's substitution inert", () => {
    // A quoted or escaped delimiter makes the body literal text: the
    // shell never runs the substitution, so nothing may be expanded
    // out of it — and there is no expansion to review, so the command
    // decomposes to Skip rather than a themed review.
    for (const opener of ["<<'EOF'", '<<"EOF"', "<<\\EOF"]) {
      const review = classifyRiskWithCause(
        normalizeToolCall("bash", { command: `cat ${opener}\n$(rm -rf /tmp/work)\nEOF` }, "/w/r"),
      );
      expect(review, opener).toEqual({ disposition: "Skip" });
    }
  });

  it("keeps a bare command in an active body inert data", () => {
    // No substitution, nothing runs, and the body carries no expansion
    // characters either: the body is cat's stdin, and a forced deletion
    // spelled as plain data deletes nothing (measured in bash; codex
    // agrees, safe). A bare delimiter alone no longer raises a review.
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "cat <<EOF\nrm -rf /tmp/work\nEOF" }, "/w/r"),
    );
    expect(review).toEqual({ disposition: "Skip" });
  });

  it("keeps a harmless body substitution a review, not a refusal", () => {
    // `pwd` runs but names no danger, so the command stays a review
    // for the substitution it cannot prove.
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "cat <<EOF\n$(pwd)\nEOF" }, "/w/r"),
    );
    expect(review).toEqual({
      disposition: "NeedsApproval",
      cause: "substitution_unproven",
    });
  });

  it("judges a dangerous substitution identically in both positions", () => {
    // The regression this test pins: real bash runs the same live
    // substitution from an inline position and from an active heredoc
    // body alike, so the two spellings must earn the same disposition.
    // Before the fix only the inline position reached tier 1's danger
    // check — the body's substitution was invisible to it.
    const inline = classifyRisk(
      normalizeToolCall("bash", { command: "echo $(rm -rf /tmp/work)" }, "/w/r"),
    );
    const inBody = classifyRisk(
      normalizeToolCall("bash", { command: "cat <<EOF\n$(rm -rf /tmp/work)\nEOF" }, "/w/r"),
    );
    expect(inline).toBe("NeedsApproval");
    expect(inBody).toBe(inline);
  });
});

describe("heredoc bodies are data, not commands", () => {
  // A heredoc body is the command's stdin, so a bare command spelled
  // inside it runs nothing. Each expectation below is the behaviour
  // real bash was measured to have: the body is inert text, and only
  // what follows a bare delimiter line is a command again.
  it("raises no segment for a bare command inside a body", () => {
    const segments = parseCommandSegments("cat <<EOF\nrm -f /tmp/work\nEOF");
    expect(segments.map((segment) => segment.executable)).toEqual(["cat"]);
  });

  it("does not forbid a forced deletion that is only body data", () => {
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "cat <<EOF\nrm -f /tmp/work\nEOF" }, "/w/r"),
    );
    expect(review).toEqual({ disposition: "Skip" });
  });

  it("keeps an inert body's substitution inert, so the command decomposes", () => {
    const segments = parseCommandSegments("cat <<'EOF'\n$(rm -rf /)\nEOF");
    expect(segments.map((segment) => segment.executable)).toEqual(["cat"]);
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "cat <<'EOF'\n$(rm -rf /)\nEOF" }, "/w/r"),
    );
    expect(review).toEqual({ disposition: "Skip" });
  });

  it("resumes segmentation after the delimiter line", () => {
    const segments = parseCommandSegments("cat <<EOF\ndata\nEOF\nrm -f /tmp/x");
    expect(segments.map((segment) => segment.executable)).toEqual(["cat", "rm"]);
    expect(
      classifyRisk(
        normalizeToolCall("bash", { command: "cat <<EOF\ndata\nEOF\nrm -f /tmp/x" }, "/w/r"),
      ),
    ).toBe("NeedsApproval");
  });

  it("reads an unterminated heredoc as data to the end, inventing no commands", () => {
    // The delimiter line must be the bare delimiter; `EOF && git push`
    // is body data, so the heredoc never closes and nothing after the
    // first line is a command.
    const segments = parseCommandSegments("cat <<EOF\nrm -rf /\nEOF && git push");
    expect(segments.map((segment) => segment.executable)).toEqual(["cat"]);
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "cat <<EOF\nrm -rf /\nEOF && git push" }, "/w/r"),
    );
    expect(review).toEqual({ disposition: "Skip" });
  });

  it("consumes queued bodies in order, then resumes segmentation", () => {
    const segments = parseCommandSegments("cat <<A <<B\nx\nA\ny\nB\nrm -f /tmp/x");
    expect(segments.map((segment) => segment.executable)).toEqual(["cat", "rm"]);
  });

  it("matches a strip-tabs delimiter once its leading tabs are gone", () => {
    const segments = parseCommandSegments("cat <<-EOF\n\tx\n\tEOF\nrm -f /tmp/x");
    expect(segments.map((segment) => segment.executable)).toEqual(["cat", "rm"]);
  });

  it("opens no heredoc for a << inside a comment", () => {
    // A `#` that begins a word comments the rest of its line, so
    // the `<<EOF` there is text and the lines after it are real
    // commands — measured in bash, which runs them. The splitter
    // keeps cutting them, so a forced deletion a commented
    // heredoc appears to swallow stays visible.
    const segments = parseCommandSegments("git push # <<EOF\nrm -f /tmp/x\nEOF");
    expect(segments.map((segment) => segment.executable)).toEqual(["git", "rm", "eof"]);
    expect(
      classifyRisk(
        normalizeToolCall("bash", { command: "git push # <<EOF\nrm -f /tmp/x\nEOF" }, "/w/r"),
      ),
    ).toBe("NeedsApproval");
  });
});

describe("skipped heredoc substitutions stay index-aligned with the splitter", () => {
  // `skippedHeredocSubstitutions` walks the command a second time and
  // hands each skipped active body's substitutions to the chunk that
  // opened it, matched by index. Two traversals of the same grammar can
  // drift, and drift here fails open: an entry past the last chunk is
  // never read, so the substitution silently leaves tier 1's view. These
  // invariants hold for every shape regardless of which side moved.
  const forced = ["rm", "-rf", "/tmp/work"].join(" ");
  const forcedFile = ["rm", "-f", "/tmp/x"].join(" ");
  const shapes = [
    `cat <<EOF\n$(${forced})\nEOF`,
    `cat <<'EOF'\n$(${forced})\nEOF`,
    `cat <<"EOF"\n$(${forced})\nEOF`,
    `cat <<\\EOF\n$(${forced})\nEOF`,
    `cat <<-EOF\n\t$(${forced})\n\tEOF`,
    `cat <<EOF\n$(${forced})`,
    `cat <<A <<B\nx\nA\n$(${forcedFile})\nB`,
    `cat <<A <<B\n$(${forcedFile})\nA\ny\nB`,
    `cat <<'A' <<B\nx\nA\n$(${forcedFile})\nB`,
    `cat <<A <<'B'\n$(${forcedFile})\nA\ny\nB`,
    `cat <<'A' <<'B' <<C\nx\nA\ny\nB\n$(${forcedFile})\nC`,
    `cat <<A <<'B' <<C\n$(${forcedFile})\nA\ny\nB\nz\nC`,
    `cat 2<<EOF\n$(${forced})\nEOF`,
    `echo hi; cat <<EOF\n$(${forced})\nEOF`,
    `cat <<EOF\n$(${forced})\nEOF; echo hi`,
    `cat <<EOF\n$(${forced})\nEOF | grep x`,
    `( cat <<EOF\n$(${forced})\nEOF )`,
    `if true; then cat <<EOF\n$(${forced})\nEOF\nfi`,
    `for i in 1; do cat <<EOF\n$(${forced})\nEOF\ndone`,
    `cat <<EOF\n${forced}\nEOF`,
    `cat <<EOF\n$(pwd)\nEOF`,
    `echo "<<EOF"\n$(${forcedFile})`,
    `git push # <<EOF\n${forcedFile}\nEOF`,
    "cat <<EOF",
    "cat <<",
    "echo 1 <<str",
    // Over-strict false positives: an unclosed literal `((` in an earlier
    // word must not reach across a command separator and cancel a real
    // heredoc opener. Measured in bash — the victim survives every one of
    // these, so `Forbidden` here would block a deletion the shell never
    // runs. The last entry is the control: a *closed* `$((1))` never
    // misfired, before or after the separator guard.
    `echo "((" ; cat <<'EOF'\n$(${forced})\nEOF`,
    `echo "((" ; cat <<EOF\n${forcedFile}\nEOF`,
    `echo "(("\ncat <<'EOF'\n$(${forced})\nEOF`,
    `(( ; cat <<'EOF'\n$(${forced})\nEOF`,
    `echo x # ((\ncat <<'EOF'\n$(${forced})\nEOF`,
    `echo "((" && cat <<'EOF'\n$(${forced})\nEOF`,
    `echo $((1)) ; cat <<'EOF'\n$(${forced})\nEOF`,
  ];

  it("attributes an active body to the chunk that opened its heredoc", () => {
    // `echo` is chunk 0 and opens nothing. The body belongs to `cat`,
    // chunk 1. A mis-attribution still classifies Forbidden — the
    // expander does not care which host segment received the body — so
    // only this index check catches it. Index 0 is a hole (`undefined`),
    // not `null`: `JSON.stringify` renders that hole as null.
    const command = `echo hi; cat <<EOF\n$(${forcedFile})\nEOF`;
    const skipped = skippedHeredocSubstitutions(command);
    expect(splitShellSegments(command)).toHaveLength(2);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toBeUndefined();
    expect(skipped[1]).toEqual([forcedFile]);
  });

  it("names substitution_unproven once D4 sees a mixed-queue body", () => {
    // D4 makes `commandHasExecutableSubstitution` ask
    // `skippedHeredocSubstitutions` after the raw scan. Before that, the
    // mixed queue was `heredoc_unproven`: the raw scan drops an active
    // body queued ahead of an inert one, so `$(pwd)` never became
    // `substitution_unproven`. Both shapes are that cause now. Deleting
    // the D4 question splits them again.
    for (const command of ["cat <<A\n$(pwd)\nA", "cat <<A <<'B'\n$(pwd)\nA\ny\nB"]) {
      expect(
        classifyRiskWithCause(normalizeToolCall("bash", { command }, "/w/r")),
        command,
      ).toEqual({ disposition: "NeedsApproval", cause: "substitution_unproven" });
    }
  });

  it("pins a disposition on every shape, so no corpus entry is unjudged", () => {
    // Every entry of `shapes` gets an expected disposition here, derived by
    // index rather than retyped, so adding a shape without judging it fails
    // this test instead of silently widening the unjudged set. The old form
    // asserted `toHaveLength(11)` against a hand-typed literal: the count
    // compared only with itself, and the "26 - 12 - 3" arithmetic lived in a
    // comment nothing checked.
    //
    // `shapes[1]`–`shapes[3]` and `shapes[26]`–`shapes[31]` are quoted-delimiter
    // heredocs whose bodies bash never re-reads: no `heredoc_unproven` anymore,
    // so they decompose to `Skip`. `shapes[19]`, `shapes[23]` and `shapes[25]`
    // are bare delimiters whose (possibly unterminated) bodies carry no `$` or
    // backtick, so no expansion risk and no review either. `shapes[21]` and
    // `shapes[22]` are NeedsApproval *without* `dangerousSubstitution` because the
    // `$(` there is shredded by an operator or sits in a comment, so it is not
    // `nestedFrom === "substitution"` (`risk.ts`) — that asymmetry is intended.
    // `shapes[24]` (`cat <<`) is an incomplete heredoc: every segment is
    // `lex_incomplete`, so the codex-aligned B1 fallback (`risk.ts` tier 4a)
    // judges the raw words — first word `cat`, non-dangerous — → `Skip`. codex
    // likewise falls back to the raw command vector when a parse yields no plain
    // commands and allows a non-dangerous one (`exec_policy.rs`). The fallback
    // is all-or-nothing on `lex_incomplete`, so no other shape reaches it:
    // each has a segment with a stronger unproven reason (heredoc,
    // substitution, or a variable executable) and fails closed instead.
    const expected: readonly RiskClassification[] = [
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forcedFile },
      { disposition: "NeedsApproval", dangerousSubstitution: forcedFile },
      { disposition: "NeedsApproval", dangerousSubstitution: forcedFile },
      { disposition: "NeedsApproval", dangerousSubstitution: forcedFile },
      { disposition: "NeedsApproval", dangerousSubstitution: forcedFile },
      { disposition: "NeedsApproval", dangerousSubstitution: forcedFile },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "Skip" },
      { disposition: "NeedsApproval", cause: "substitution_unproven" },
      { disposition: "NeedsApproval" },
      { disposition: "NeedsApproval" },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "NeedsApproval", cause: "substitution_unproven" },
    ];
    expect(expected).toHaveLength(shapes.length);
    shapes.forEach((command, index) => {
      expect(
        classifyRiskWithCause(normalizeToolCall("bash", { command }, "/w/r")),
        `${index}: ${command}`,
      ).toEqual(expected[index]);
    });
    for (const command of ["cat <<EOF", "cat <<", "echo 1 <<str"]) {
      expect(() => splitShellSegments(command), command).not.toThrow();
      expect(() => skippedHeredocSubstitutions(command), command).not.toThrow();
    }
  });

  it("keeps a quoted character inside a comment from swallowing lines", () => {
    // D7 added `!comment` to the quote branch (`shell-lexer.ts`), not to the
    // `<<` operator branch — that one already had it. So the shape that pins
    // D7 is a quote *inside a comment*: at HEAD the apostrophe opened a quote
    // region that ran to end of input, `lex_incomplete` swallowed the next
    // line as string data, and a forced deletion bash really runs escaped
    // tier 1. Measured in bash: rc=0, victim deleted, stderr empty.
    const apostrophe = String.fromCharCode(39);
    const shapes: readonly [string, { disposition: string; cause?: string }][] = [
      [`git push # don${apostrophe}t\n${forcedFile}`, { disposition: "NeedsApproval" }],
      [`echo hi # ${apostrophe}$(${forcedFile})`, { disposition: "NeedsApproval" }],
    ];
    for (const [command, expected] of shapes) {
      expect(
        classifyRiskWithCause(normalizeToolCall("bash", { command }, "/w/r")),
        command,
      ).toEqual(expected);
    }
    // The segments prove the mechanism: the deletion is its own chunk, not
    // string data inside an unterminated quote.
    expect(splitShellSegments(`git push # don${apostrophe}t\n${forcedFile}`)).toEqual([
      `git push # don${apostrophe}t`,
      forcedFile,
    ]);
  });

  it("reads a shift inside arithmetic as arithmetic, and a digit-led delimiter whole", () => {
    // D1B replaced two fd-digit scans with `insideArithmeticContext`. Both
    // halves are measured in bash, victim deleted in every case:
    //
    // 1. `<<x` inside `$(( ))` is a shift operator, not a heredoc. At HEAD the
    //    `<<` opened a heredoc that swallowed the next line as body data, so
    //    the forced deletion never reached tier 1.
    // 2. `cat <<2X` names the delimiter `2X`. The removed scans ate the
    //    leading digits and looked for `X`, so the real terminator line `2X`
    //    never closed the heredoc and the command after it stayed hidden.
    const arith: readonly [string, { disposition: string }][] = [
      [`echo $((1<<x))\n${forcedFile}`, { disposition: "NeedsApproval" }],
      [`((1<<x))\n${forcedFile}`, { disposition: "NeedsApproval" }],
    ];
    const digitDelims: readonly [string, { disposition: string }][] = [
      [`cat <<2X\nbody\n2X\n${forcedFile}`, { disposition: "NeedsApproval" }],
      [`cat <<0EOF\nbody\n0EOF\n${forcedFile}`, { disposition: "NeedsApproval" }],
    ];
    for (const [command, expected] of [...arith, ...digitDelims]) {
      expect(
        classifyRiskWithCause(normalizeToolCall("bash", { command }, "/w/r")),
        command,
      ).toEqual(expected);
    }
    // The delimiter is `2X`, so a line reading `X` does not close the heredoc
    // and the deletion after it is body data — the opposite of the case above.
    expect(splitShellSegments(`cat <<2X\nbody\n2X\n${forcedFile}`)).toEqual([
      "cat <<2X",
      forcedFile,
    ]);
    expect(
      classifyRiskWithCause(
        normalizeToolCall("bash", { command: `cat <<2X\nbody\nX\n${forcedFile}` }, "/w/r"),
      ),
    ).toEqual({ disposition: "Skip" });
  });

  it("projects segments and skipped bodies from one traversal", () => {
    // The two exports are projections of `splitShellText`, so this compares a
    // pure function with a manual call of itself: it cannot fail while the
    // projections exist. What it guards is re-splitting — if someone gives
    // either export its own walk again, the two can drift and this goes red.
    // The bound below holds structurally (`chunk` is captured as
    // `segments.length` before the push, and the body loop pushes before
    // consuming), so wrong-but-in-range attribution is what actually needs a
    // pin; that is "attributes an active body to the chunk that opened its
    // heredoc" above, for one shape.
    for (const command of shapes) {
      const once = splitShellText(command);
      expect(splitShellSegments(command), command).toEqual(once.segments);
      expect(skippedHeredocSubstitutions(command), command).toEqual(once.skippedBodies);
      for (const [index, bodies] of once.skippedBodies.entries()) {
        if (bodies === undefined || bodies.length === 0) continue;
        expect(index, command).toBeLessThan(once.segments.length);
      }
    }
  });

  it("never attributes a body past the last chunk, where no reader looks", () => {
    for (const command of shapes) {
      const chunks = splitShellSegments(command);
      const skipped = skippedHeredocSubstitutions(command);
      for (const [index, bodies] of skipped.entries()) {
        if (bodies === undefined || bodies.length === 0) continue;
        expect(
          index,
          `body lost past chunk ${chunks.length - 1} in ${JSON.stringify(command)}`,
        ).toBeLessThan(chunks.length);
      }
    }
  });

  it("attributes only substitutions the command text really carries", () => {
    // Inventing a body would be its own defect: tier 1 would refuse a
    // deletion the shell never runs. Every attributed body has to be a
    // substitution the command actually spells, so nothing is refused
    // that the text does not contain.
    //
    // Deliberately not `scanShellSyntax(command).liveSubstitutions`: that
    // scan misses a body when an active heredoc is queued ahead of an
    // inert one (`cat <<A <<'B'`), and this walk is what closes the gap.
    for (const command of shapes) {
      for (const bodies of skippedHeredocSubstitutions(command)) {
        for (const body of bodies ?? []) {
          expect(
            command.includes(`$(${body})`) || command.includes(`\`${body}\``),
            `invented body ${JSON.stringify(body)} in ${JSON.stringify(command)}`,
          ).toBe(true);
        }
      }
    }
  });

  it("closes the raw scan's gap when an active heredoc is queued first", () => {
    // `cat <<A <<'B'`: the body belongs to A, which is unquoted and so
    // runs its substitutions — measured in bash, which deletes the file.
    // The whole-command scan reports nothing live here, so without this
    // walk the forced deletion would leave tier 1's view entirely.
    const command = `cat <<A <<'B'\n$(${forcedFile})\nA\ny\nB`;
    expect(scanShellSyntax(command).liveSubstitutions).toEqual([]);
    expect(skippedHeredocSubstitutions(command).flat()).toEqual([forcedFile]);
    expect(classifyRisk(normalizeToolCall("bash", { command }, "/w/r"))).toBe("NeedsApproval");
  });

  it("refuses a forced deletion in any active body, at any queue position", () => {
    // Measured in bash: a body belongs to the heredoc operator that
    // opened it, in declaration order, and an unquoted body runs its
    // substitutions — deleting the victim file in each of these.
    for (const command of [
      `cat <<EOF\n$(${forced})\nEOF`,
      `cat <<A <<B\nx\nA\n$(${forcedFile})\nB`,
      `cat <<A <<B\n$(${forcedFile})\nA\ny\nB`,
      `cat <<'A' <<B\nx\nA\n$(${forcedFile})\nB`,
      `cat <<A <<'B'\n$(${forcedFile})\nA\ny\nB`,
      `cat <<'A' <<'B' <<C\nx\nA\ny\nB\n$(${forcedFile})\nC`,
      `cat <<-EOF\n\t$(${forced})\n\tEOF`,
      `cat <<EOF\n$(${forced})`,
      `echo hi; cat <<EOF\n$(${forced})\nEOF`,
      `( cat <<EOF\n$(${forced})\nEOF )`,
      `if true; then cat <<EOF\n$(${forced})\nEOF\nfi`,
      `for i in 1; do cat <<EOF\n$(${forced})\nEOF\ndone`,
    ]) {
      expect(classifyRisk(normalizeToolCall("bash", { command }, "/w/r")), command).toBe(
        "NeedsApproval",
      );
    }
  });

  it("leaves an inert body's substitution inert, at any queue position", () => {
    // The same bodies, quoted: bash reads them as literal text and the
    // victim file survives, so a refusal here would be a false positive.
    // There is nothing to review at all now: an inert body never expands.
    for (const command of [
      `cat <<'EOF'\n$(${forced})\nEOF`,
      `cat <<"EOF"\n$(${forced})\nEOF`,
      `cat <<\\EOF\n$(${forced})\nEOF`,
      `cat <<-'EOF'\n\t$(${forced})\n\tEOF`,
      `cat <<'A' <<B\n$(${forcedFile})\nA\ny\nB`,
      `cat <<A <<'B'\nx\nA\n$(${forcedFile})\nB`,
      `cat <<'A' <<'B' <<'C'\n$(${forcedFile})\nA\ny\nB\nz\nC`,
    ]) {
      expect(
        classifyRiskWithCause(normalizeToolCall("bash", { command }, "/w/r")),
        command,
      ).toEqual({ disposition: "Skip" });
    }
  });
});
