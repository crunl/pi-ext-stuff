/**
 * Regression tests for `env` assignment-item recognition, the
 * codex-aligned predicate that closes the wrapper-walk gap.
 *
 * Real bash runs `env 1=foo rm -f /tmp/x`: coreutils `env`
 * accepts any `NAME=` item whose name is non-empty and does not
 * start with `-`, whether or not the name is a legal shell
 * identifier. codex's `is_dangerous_command.rs` judges that
 * input `ForcedRm`. pi-safety used to stop the `env` wrapper
 * walk at the first item `assignmentName` rejected, so the
 * `rm` behind `1=foo` / `FOO-BAR=1` was never seen.
 */
import { describe, expect, it } from "vitest";
import { isDangerousWords } from "../src/permissions/dangerous-commands.ts";
import {
  classifyRiskWithCause,
  normalizeToolCall,
  parseCommandSegments,
} from "../src/permissions/risk.ts";

describe("env assignment items (codex-aligned)", () => {
  it("unwraps an assignment whose name is not a shell identifier", () => {
    // Both spellings are ordinary assignments to `env`, so the
    // walk must continue past them to the `rm`.
    expect(isDangerousWords(["env", "1=foo", "rm", "-f", "/tmp/x"])).toBe(true);
    expect(isDangerousWords(["env", "FOO-BAR=1", "rm", "-f", "/tmp/x"])).toBe(true);
  });

  it("keeps unwrapping legal-identifier assignments", () => {
    expect(isDangerousWords(["env", "A=1", "rm", "-f", "/tmp/x"])).toBe(true);
    expect(isDangerousWords(["env", "PATH=/tmp", "rm", "-f", "/tmp/x"])).toBe(true);
  });

  it("does not read a nameless or option-shaped word as an assignment", () => {
    // `env =foo cmd`: the left side is empty, so `=foo` is the
    // program `env` itself tries to run (and fails on) — not an
    // assignment item.
    expect(isDangerousWords(["env", "=foo", "rm", "-f", "/tmp/x"])).toBe(false);
    // A `-`-prefixed word is an option (`--chdir=/tmp`), never an
    // assignment, however many `=` it carries.
    expect(isDangerousWords(["env", "-foo=bar", "rm", "-f", "/tmp/x"])).toBe(false);
    expect(isDangerousWords(["env", "--chdir=/tmp", "rm", "-f", "/tmp/x"])).toBe(false);
  });

  it("reviews a forced removal behind a non-identifier assignment", () => {
    for (const command of [
      "env 1=foo rm -f /tmp/x",
      "env FOO-BAR=1 rm -f /tmp/x",
      "sudo env 1=foo rm -f /tmp/x",
      "env 1=foo rm -f /tmp/x && echo after",
    ]) {
      const review = classifyRiskWithCause(normalizeToolCall("bash", { command }, "/work/repo"));
      expect(review.disposition, command).toBe("NeedsApproval");
    }
  });

  it("keeps the bare shell assignment prefix identifier-only", () => {
    // `1=foo echo hi` is a command-not-found in bash, not an
    // assignment: the bare-assignment prefix must keep requiring
    // a legal identifier, so `1=foo` stays the command word and
    // this path is unchanged by the env fix.
    const segments = parseCommandSegments("1=foo echo hi");
    expect(segments.map((segment) => segment.executable)).toEqual(["1=foo"]);
  });
});

describe("env -- terminator (codex-aligned, known gap)", () => {
  it("stops at a bare -- and still reviews a nameless assignment", () => {
    // Known shared defect, deliberately not fixed. `dangerousEnv` breaks
    // out of assignment parsing at a bare `--`, statement for statement
    // with codex `is_dangerous_command.rs`, so both judge the `rm` behind
    // it not dangerous (`isDangerousWords` false, this path Skip).
    //
    // Real bash on this machine does run the deletion: `env -- 1=foo`
    // followed by a forced `rm` of a victim returned rc=0, the victim
    // was deleted, and stderr was empty. That is BSD/macOS `env`
    // (`man env` SYNOPSIS is `env [-0iv] [-u name] [name=value ...]
    // utility [argument ...]`; `env --version` is `illegal option -- e`,
    // so this is not GNU coreutils, and GNU was not verified — no GNU
    // `env` and no container on this machine). Measured here: `env --
    // FOO=1 printenv FOO` returns rc=0 and prints `1`, so `--` does not
    // end assignment parsing; `env FOO=1 -- printenv FOO` returns rc=127
    // (`env: --: No such file or directory`), so a `--` after the
    // assignment phase is the command name. The automatic-execution
    // stop for the first spelling is the seatbelt sandbox, not this
    // classification.
    //
    // The `=foo` control is the opposite pair and must stay opposite:
    // codex judges it dangerous, pi reviews it, and real bash does not
    // delete. Pinning only the `--` Skip would not catch a change that
    // rewrote `--` handling wholesale.
    expect(isDangerousWords(["env", "--", "1=foo", "rm", "-f", "/tmp/x"])).toBe(false);
    expect(isDangerousWords(["env", "--", "FOO=1", "rm", "-rf", "/tmp/x"])).toBe(false);
    expect(
      classifyRiskWithCause(
        normalizeToolCall("bash", { command: "env -- 1=foo rm -f /tmp/x" }, "/work/repo"),
      ),
    ).toEqual({ disposition: "Skip" });
    expect(
      classifyRiskWithCause(
        normalizeToolCall("bash", { command: "env =foo rm -f /tmp/x" }, "/work/repo"),
      ),
    ).toEqual({ disposition: "NeedsApproval" });
    // Cut 3 keeps `=`-leading executables in review even though bash never
    // executes them ("No such file"): the spelling is zsh filename
    // expansion, and `zsh -c '=rm …'` shares it exactly — statically
    // indistinguishable without a PATH lookup, so both review.
  });
});

describe("rm -f without recursion on concrete in-cwd targets", () => {
  const cwd = "/work/repo";
  const risk = (
    command: string,
    protectedWritePaths: readonly string[] = [],
    denyWrite: readonly string[] = [],
  ) =>
    classifyRiskWithCause(
      normalizeToolCall("bash", { command }, cwd),
      protectedWritePaths,
      denyWrite,
    ).disposition;

  it("skips force removal that can delete at most named workspace entries", () => {
    for (const command of [
      "rm -f notes.txt",
      "rm -f",
      "rm --force a.txt b.txt",
      "rm -f -- -rf",
      "rm -f sub/dir/file.txt",
      // The parser already consumed the escape: the word is the runtime word.
      "rm -f a\\ b",
    ]) {
      expect(risk(command), command).toBe("Skip");
    }
  });

  it("keeps review for recursion, escapes, runtime-chosen names, and dir removal", () => {
    for (const command of [
      "rm -rf dist",
      "rm -rf /",
      "rm -rf src",
      "rm -fr x",
      "rm -fR x",
      "rm -fd emptydir",
      "rm -f ../../x",
      "rm -f ~/x",
      "rm -f /abs/path.txt",
      "rm -f *.log",
      "rm -f $DIR",
      "rm -f `hostname`.txt",
    ]) {
      expect(risk(command), command).toBe("NeedsApproval");
    }
  });

  it("keeps review for protected controls and denyWrite names", () => {
    expect(risk("rm -f id.pem", [], ["*.pem"]), "denyWrite glob").toBe("NeedsApproval");
    expect(risk("rm -f .env", [], [".env"]), "denyWrite literal").toBe("NeedsApproval");
    expect(risk("rm -f secret", ["/work/repo/secret"]), "protected control").toBe("NeedsApproval");
    expect(risk("rm -f secret/file.txt", ["/work/repo/secret"]), "under protected dir").toBe(
      "NeedsApproval",
    );
    expect(risk("rm -f notes.txt", [], ["*.pem"]), "unrelated pattern").toBe("Skip");
    // Case folds where the platform does: on darwin/win32 `ID.PEM` names
    // the same file `*.pem` denies, so it reviews; on case-sensitive
    // filesystems it is genuinely a different name, so it Skips.
    expect(risk("rm -f ID.PEM", [], ["*.pem"]), "denyWrite case variant").toBe(
      process.platform === "linux" ? "Skip" : "NeedsApproval",
    );
  });
});
