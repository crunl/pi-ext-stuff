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

  it("forbids a forced removal behind a non-identifier assignment", () => {
    for (const command of [
      "env 1=foo rm -f /tmp/x",
      "env FOO-BAR=1 rm -f /tmp/x",
      "sudo env 1=foo rm -f /tmp/x",
      "env 1=foo rm -f /tmp/x && echo after",
    ]) {
      const review = classifyRiskWithCause(
        normalizeToolCall("bash", { command }, "/work/repo"),
        true,
      );
      expect(review.disposition, command).toBe("Forbidden");
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
