/**
 * Activation failure path: the grammar cannot be read (missing package,
 * corrupt WASM, mid-session trap). The bridge reports the failure, installs
 * nothing, and every bash verdict fails closed to review (`ast_unavailable`)
 * rather than blocking the request or answering blind.
 *
 * The failure is driven through the deterministic
 * `simulateTreeSitterShellFailure` seam: the `node:fs`/`node:module` mocks the
 * previous revision used cannot intercept reads the shared suite setup
 * already performed, which made the failure order-dependent. What matters
 * here is the broken STATE (reported reason, no install, fail-closed
 * verdicts), not which I/O call produced it.
 */
import { afterEach, describe, expect, it } from "vitest";

import { classifyRiskWithCause, normalizeToolCall } from "../src/permissions/risk.ts";
import { installShellAstParser, shellAstParserInstalled } from "../src/permissions/shell-ast.ts";
import { parseCommandSegments } from "../src/permissions/shell-segment.ts";
import {
  activateTreeSitterShellParser,
  resetTreeSitterShellActivation,
  resetTreeSitterShellBackend,
  shellAstParser,
  simulateTreeSitterShellFailure,
  treeSitterShellFailure,
} from "../src/tree-sitter/shell-backend.ts";

describe("tree-sitter activation failure fails closed to review", () => {
  afterEach(() => {
    installShellAstParser(undefined);
    resetTreeSitterShellActivation();
    resetTreeSitterShellBackend();
  });

  it("reports the reason, installs nothing, and never throws", async () => {
    // Reset the suite-wide install first so this observes its own state.
    installShellAstParser(undefined);
    resetTreeSitterShellActivation();
    resetTreeSitterShellBackend();
    simulateTreeSitterShellFailure("simulated corrupt grammar");
    await expect(activateTreeSitterShellParser()).resolves.toBe(false);
    expect(shellAstParserInstalled()).toBe(false);
    expect(shellAstParser()).toBeUndefined();
    const failure = treeSitterShellFailure();
    expect(failure).toBeDefined();
    expect(failure?.message).toBe("simulated corrupt grammar");
  });

  it("reviews every bash command while the bridge is broken", async () => {
    installShellAstParser(undefined);
    resetTreeSitterShellActivation();
    resetTreeSitterShellBackend();
    simulateTreeSitterShellFailure("simulated corrupt grammar");
    await activateTreeSitterShellParser();
    // Plain commands review: with no parser the layer is blind, and blind
    // is a review, per product decision — never a silent Skip.
    for (const command of ["pwd", "ls -la", "rm -f /tmp/work", "rm -f /tmp/work &&"]) {
      const segments = parseCommandSegments(command);
      expect(segments.some((segment) => segment.unprovenCause === "ast_unavailable"), command).toBe(
        true,
      );
      const review = classifyRiskWithCause(normalizeToolCall("bash", { command }, "/work/repo"));
      expect(review.disposition, command).toBe("NeedsApproval");
    }
    // The forced-deletion review is unchanged in disposition (it was already
    // a review), now carried by the blind cause instead of the danger proof.
    const request = normalizeToolCall("bash", { command: "rm -rf /" }, "/work/repo");
    expect(classifyRiskWithCause(request).disposition).toBe("NeedsApproval");
  });

  it("a parser that throws mid-session fails that command closed, not the suite", async () => {
    // The pure layer's slot still holds the object it was given when the
    // bridge drops it, so a throwing parse must fall back per command.
    installShellAstParser({
      parse(): never {
        throw new Error("wasm trap");
      },
    });
    expect(() => parseCommandSegments("pwd")).not.toThrow();
    const segments = parseCommandSegments("pwd");
    expect(segments.some((segment) => segment.unprovenCause === "ast_unmodelled")).toBe(true);
    const review = classifyRiskWithCause(
      normalizeToolCall("bash", { command: "pwd" }, "/work/repo"),
    );
    expect(review.disposition).toBe("NeedsApproval");
  });
});
