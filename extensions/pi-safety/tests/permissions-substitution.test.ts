import { describe, expect, it } from "vitest";
import {
  classifyRisk,
  classifyRiskWithCause,
  normalizeToolCall,
  parseCommandSegments,
  type RiskClassification,
} from "../src/permissions/risk.ts";
import { outermostSubstitutionBodies } from "../src/permissions/shell-tokens.ts";

describe("live substitution extraction", () => {
  it("reports the outermost live body per site, inert ones none", () => {
    // One body per substitution site; deeper levels surface through the
    // expander's recursion rather than arriving nested (which multiplied
    // work exponentially). Siblings each report.
    expect(outermostSubstitutionBodies("echo $(date)")).toEqual(["date"]);
    expect(outermostSubstitutionBodies('echo "$(date)"')).toEqual(["date"]);
    expect(outermostSubstitutionBodies("echo `date`")).toEqual(["date"]);
    expect(outermostSubstitutionBodies("echo $(a) $(b)")).toEqual(["a", "b"]);
    // Inert spellings: single quotes and `\$` never run.
    expect(outermostSubstitutionBodies("echo '$(date)'")).toEqual([]);
    expect(outermostSubstitutionBodies("echo \\$(date)")).toEqual([]);
    expect(outermostSubstitutionBodies("echo \\`date\\`")).toEqual([]);
    // Parameter expansion has no body to read.
    expect(outermostSubstitutionBodies("echo $HOME ${VAR:-x} $1")).toEqual([]);
    // Nesting reports the outer site only; the recursion owns the inside.
    expect(outermostSubstitutionBodies('echo "$(echo "$(date)")"')).toEqual(['echo "$(date)"']);
    expect(outermostSubstitutionBodies("echo $(echo ')')")).toEqual(["echo ')'"]);
    // Unclosed forms yield no body at all: half-matched text never reaches
    // a parser (the booleans fail the command closed elsewhere).
    expect(outermostSubstitutionBodies("echo $(date")).toEqual([]);
    expect(outermostSubstitutionBodies("echo `date")).toEqual([]);
  });

  it("caps reported bodies", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `$(echo ${i})`).join(" ");
    expect(outermostSubstitutionBodies(`echo ${nine}`)).toHaveLength(8);
  });

  it("surfaces bodies as nested segments, inert spellings as none", () => {
    // The outermost body parses to its own segments; an inert spelling
    // contributes no segment at all.
    expect(
      parseCommandSegments("echo $(date)").some((segment) => segment.executable === "date"),
    ).toBe(true);
    expect(
      parseCommandSegments("echo '$(date)'").some((segment) => segment.executable === "date"),
    ).toBe(false);
    expect(
      parseCommandSegments("echo \\$(date)").some(
        (segment) => segment.executable === "date" || segment.executable === "$(date)",
      ),
    ).toBe(false);
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
    // Cut 3: a live but harmless substitution is no longer a review — Tier 1
    // still screens the body, and `date` screens clean. Quoted and unquoted
    // stay identical (both Skip), as do the dangerous twins above.
    for (const command of ['echo "$(date)"', "echo $(date)", "echo `date`"]) {
      expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo")), command).toBe(
        "Skip",
      );
    }
  });
});

describe("inert heredoc bodies", () => {
  it("reads a quoted-delimiter body as literal text, not shell code", () => {
    // A quoted or escaped delimiter makes the body literal: the substitution
    // in it never runs, so the command decomposes and reviews nothing.
    for (const opener of ["<<'EOF'", '<<"EOF"', "<<\\EOF"]) {
      const command = `cat ${opener}\n$(date) ; more\nEOF`;
      const [segment] = parseCommandSegments(command);
      expect(segment?.executable, opener).toBe("cat");
      expect(segment?.decomposable, opener).toBe(true);
      expect(classifyRisk(normalizeToolCall("bash", { command }, "/work/repo")), opener).toBe(
        "Skip",
      );
    }
  });

  it("keeps an unquoted-delimiter body live, because bash expands it", () => {
    const segments = parseCommandSegments("cat <<EOF\n$(date)\nEOF");
    expect(segments.some((segment) => segment.executable === "date")).toBe(true);
    expect(
      classifyRisk(normalizeToolCall("bash", { command: "cat <<EOF\n$(date)\nEOF" }, "/work/repo")),
    ).toBe("Skip");
  });

  it("treats a prefix-colliding delimiter line as unprovable", () => {
    // The grammar closes a heredoc on a PREFIX match: `EOFx` ends a `<<'EOF'`
    // body early and the lines behind it become segments. Real bash only
    // closes on the bare delimiter, so review here is a fail-closed false
    // positive on a pathological shape — never a miss: the bare-delimiter
    // live variant reviews for a deletion that really runs.
    expect(
      classifyRisk(
        normalizeToolCall("bash", { command: "cat <<'EOF'\nEOFx\n$(date)\nEOF" }, "/w/r"),
      ),
    ).toBe("NeedsApproval");
    expect(
      classifyRisk(
        normalizeToolCall("bash", { command: "cat <<EOF\nEOFx\n$(rm -rf /tmp/x)\nEOF" }, "/w/r"),
      ),
    ).toBe("NeedsApproval");
    // A pipeline the grammar nests inside the redirect (`| $(…)` after the
    // opener) runs code the argv walk never visits, so the whole command
    // abstains and reviews rather than dropping the stage silently.
    const piped = "cat <<'EOF' | $(date)\nEOF";
    expect(parseCommandSegments(piped).some((s) => s.unprovenCause === "ast_unmodelled")).toBe(
      true,
    );
    expect(classifyRisk(normalizeToolCall("bash", { command: piped }, "/w/r"))).toBe(
      "NeedsApproval",
    );
    // Two single-opener heredocs in a row each keep their own body.
    expect(parseCommandSegments("cat <<'A'\nx\nA").map((s) => s.executable)).toEqual(["cat"]);
  });

  it("does not invent heredocs where bash sees none", () => {
    // Process substitution with a spaced redirect: not `<<`.
    expect(
      classifyRisk(normalizeToolCall("bash", { command: "cat < <(echo hi)" }, "/work/repo")),
    ).toBe("Skip");
    expect(parseCommandSegments("cat < <(echo hi)").map((s) => s.executable)).toContain("echo");
    // A `<<` inside double quotes is literal text.
    expect(
      classifyRisk(normalizeToolCall("bash", { command: `echo "a <<'b'\nc\nEOF"` }, "/work/repo")),
    ).toBe("Skip");
    // A here-string feeds one expanding word: its substitution stays live,
    // exactly as the shell expands it.
    const segments = parseCommandSegments('wc <<< "$(date)"');
    expect(segments.some((segment) => segment.executable === "date")).toBe(true);
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

  it("runs a nested harmless body sandboxed (cut 3)", () => {
    // Cut 3 retired the substitution review along with Tier 4: the inner
    // `pkill` names no dangerous argv, so the whole command runs and the
    // sandbox owns the signal. A dangerous body still reviews — see the
    // forced-deletion cases above.
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "echo $(pkill x)" }, "/work/repo"),
    );
    expect(review).toEqual({ disposition: "Skip" });
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
    // substitution in it is still live shell source: the forced deletion
    // it would run reviews with the body as evidence.
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

  it("runs a harmless body substitution sandboxed (cut 3)", () => {
    // `pwd` runs but names no danger: no Tier-1 review, no substitution
    // review anymore — the sandbox owns it. A dangerous body still
    // reviews; a refusal was never on the table.
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "cat <<EOF\n$(pwd)\nEOF" }, "/w/r"),
    );
    expect(review).toEqual({ disposition: "Skip" });
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
    // A second bare opener misparses in the grammar, so a multi-opener
    // queue the grammar cannot read whole abstains and reviews — the body
    // data never becomes segments, and the trailing command is not proven
    // live either. Fail-closed on an unprovable queue, never invented argv.
    const segments = parseCommandSegments("cat <<A <<B\nx\nA\ny\nB\nrm -f /tmp/x");
    expect(segments.some((segment) => segment.unprovenCause === "ast_unmodelled")).toBe(true);
    expect(
      classifyRisk(
        normalizeToolCall("bash", { command: "cat <<A <<B\nx\nA\ny\nB\nrm -f /tmp/x" }, "/w/r"),
      ),
    ).toBe("NeedsApproval");
  });

  it("matches a strip-tabs delimiter once its leading tabs are gone", () => {
    const segments = parseCommandSegments("cat <<-EOF\n\tx\n\tEOF\nrm -f /tmp/x");
    expect(segments.map((segment) => segment.executable)).toEqual(["cat", "rm"]);
  });

  it("opens no heredoc for a << inside a comment", () => {
    // A `#` that begins a word comments the rest of its line, so
    // the `<<EOF` there is text and the lines after it are real
    // commands — measured in bash, which runs them.
    const segments = parseCommandSegments("git push # <<EOF\nrm -f /tmp/x\nEOF");
    expect(segments.map((segment) => segment.executable)).toEqual(["git", "rm", "eof"]);
    expect(
      classifyRisk(
        normalizeToolCall("bash", { command: "git push # <<EOF\nrm -f /tmp/x\nEOF" }, "/w/r"),
      ),
    ).toBe("NeedsApproval");
  });
});

describe("heredoc body queue", () => {
  // The grammar misparses a second bare `<<B` opener (as `<` + file
  // redirect), so a multi-heredoc queue the grammar errors inside is
  // unprovable: the whole command abstains and reviews rather than
  // inventing commands from body data. Single-opener queues parse cleanly
  // and keep their precision. All queue shapes below review when a live
  // body names danger, because the abstention reviews — the verdicts hold,
  // only the substitution evidence narrows to the clean queues.
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

  it("attributes an active body to the heredoc that opened it", () => {
    // The forced deletion in `cat`'s body reviews with the body as evidence.
    const command = `echo hi; cat <<EOF\n$(${forcedFile})\nEOF`;
    const review = classifyRiskWithCause(normalizeToolCall("bash", { command }, "/w/r"));
    expect(review).toEqual({ disposition: "NeedsApproval", dangerousSubstitution: forcedFile });
    const segments = parseCommandSegments(command);
    expect(segments.map((segment) => segment.executable)).toContain("rm");
  });

  it("runs mixed-queue bodies sandboxed once D4 is gone (cut 3)", () => {
    // A live but harmless `$(pwd)` in a clean single-heredoc queue runs
    // sandboxed. A queue the grammar cannot read whole reviews even when
    // harmless (fail-closed on unprovable bodies — the queue shapes below).
    expect(
      classifyRiskWithCause(normalizeToolCall("bash", { command: "cat <<A\n$(pwd)\nA" }, "/w/r")),
    ).toEqual({ disposition: "Skip" });
    expect(
      classifyRiskWithCause(
        normalizeToolCall("bash", { command: "cat <<A <<'B'\n$(pwd)\nA\ny\nB" }, "/w/r"),
      ),
    ).toEqual({ disposition: "NeedsApproval" });
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
    // backtick, so no expansion risk and no review either. `shapes[22]` is
    // NeedsApproval *without* `dangerousSubstitution` because the `rm` there
    // is its own line behind a comment, not inside a substitution
    // (`risk.ts`) — that asymmetry is intended. `shapes[21]` used to share
    // that shape (the splitter shredded its `$(` on the parens), but the
    // grammar reads parens, so the same review now carries the substitution
    // evidence — same verdict, better reason.
    // `shapes[24]` (`cat <<`) is an incomplete heredoc: every segment is
    // `lex_incomplete`, and the first word is `cat`, non-dangerous — →
    // `Skip`. `shapes[5]` (unterminated single queue with a live body)
    // abstains whole (`ast_unmodelled`) and reviews without the
    // substitution evidence: the body runs to end of input, so the review
    // is the fail-closed verdict, not the proof.
    // Multi-opener shapes whose queue the grammar misreads (6, 7, 9, 10,
    // 11) review the same way: same verdict, no per-body evidence.
    const expected: readonly RiskClassification[] = [
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      // Unterminated single queue with a live body: the body runs to end of
      // input, so the review carries the substitution evidence.
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      // Misread multi-opener queues: abstain whole, review verdicts hold.
      { disposition: "NeedsApproval" },
      { disposition: "NeedsApproval" },
      { disposition: "NeedsApproval" },
      { disposition: "NeedsApproval" },
      { disposition: "NeedsApproval" },
      { disposition: "NeedsApproval" },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "NeedsApproval", dangerousSubstitution: forced },
      { disposition: "Skip" },
      { disposition: "Skip" },
      { disposition: "NeedsApproval", dangerousSubstitution: forcedFile },
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
      { disposition: "Skip" },
    ];
    expect(expected).toHaveLength(shapes.length);
    shapes.forEach((command, index) => {
      expect(
        classifyRiskWithCause(normalizeToolCall("bash", { command }, "/w/r")),
        `${index}: ${command}`,
      ).toEqual(expected[index]);
    });
    for (const command of ["cat <<EOF", "cat <<", "echo 1 <<str"]) {
      expect(() => parseCommandSegments(command), command).not.toThrow();
    }
  });

  it("keeps a quoted character inside a comment from swallowing lines", () => {
    // The shape that pins this: a quote *inside a comment*. The apostrophe
    // must not open a quote region that runs to end of input, swallowing
    // the next line as string data and hiding a forced deletion bash really
    // runs. Measured in bash: rc=0, victim deleted, stderr empty.
    //
    // The second shape's `rm` sits inside a trailing comment on the SAME
    // line, which bash never runs (measured: victim survives) — Skip, while
    // the first shape (deletion on the NEXT line) still reviews.
    const apostrophe = String.fromCharCode(39);
    const shapes: readonly [string, { disposition: string; cause?: string }][] = [
      [`git push # don${apostrophe}t\n${forcedFile}`, { disposition: "NeedsApproval" }],
      [`echo hi # ${apostrophe}$(${forcedFile})`, { disposition: "Skip" }],
    ];
    for (const [command, expected] of shapes) {
      expect(
        classifyRiskWithCause(normalizeToolCall("bash", { command }, "/w/r")),
        command,
      ).toEqual(expected);
    }
    // The segments prove the mechanism: the deletion is its own segment, not
    // string data inside an unterminated quote.
    expect(
      parseCommandSegments(`git push # don${apostrophe}t\n${forcedFile}`).map((s) => s.source),
    ).toEqual([`git push # don${apostrophe}t`, forcedFile]);
  });

  it("reads a shift inside arithmetic as arithmetic, and a digit-led delimiter whole", () => {
    // Both halves are measured in bash, victim deleted in every case:
    //
    // 1. `<<x` inside `$(( ))` is a shift operator, not a heredoc: the
    //    forced deletion on the next line must stay visible.
    // 2. `cat <<2X` names the delimiter `2X`: the terminator line `2X`
    //    closes the heredoc and the command after it is live.
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
    expect(
      parseCommandSegments(`cat <<2X\nbody\n2X\n${forcedFile}`).map((s) => s.executable),
    ).toEqual(["cat", "rm"]);
    expect(
      classifyRiskWithCause(
        normalizeToolCall("bash", { command: `cat <<2X\nbody\nX\n${forcedFile}` }, "/w/r"),
      ),
    ).toEqual({ disposition: "Skip" });
  });

  it("never invents a body the command text does not spell", () => {
    // Inventing a body would be its own defect: tier 1 would review a
    // deletion the shell never runs. Every nested substitution segment must
    // come from a substitution the command actually spells.
    for (const command of shapes) {
      for (const segment of parseCommandSegments(command)) {
        if (segment.nestedFrom !== "substitution") continue;
        expect(
          segment.source.length <= command.length,
          `segment longer than its command in ${JSON.stringify(command)}`,
        ).toBe(true);
      }
    }
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
    ]) {
      expect(
        classifyRiskWithCause(normalizeToolCall("bash", { command }, "/w/r")),
        command,
      ).toEqual({ disposition: "Skip" });
    }
    // Multi-opener queues the grammar cannot read whole review even when
    // every delimiter is quoted: the queue itself is unprovable, so the
    // inert bodies behind it cannot be proven inert either. Fail-closed on
    // the queue, not on the bodies — a rare shape, safe direction.
    for (const command of [
      `cat <<'A' <<B\n$(${forcedFile})\nA\ny\nB`,
      `cat <<A <<'B'\nx\nA\n$(${forcedFile})\nB`,
      `cat <<'A' <<'B' <<'C'\n$(${forcedFile})\nA\ny\nB\nz\nC`,
    ]) {
      expect(
        classifyRiskWithCause(normalizeToolCall("bash", { command }, "/w/r")),
        command,
      ).toEqual({ disposition: "NeedsApproval" });
    }
  });
});
