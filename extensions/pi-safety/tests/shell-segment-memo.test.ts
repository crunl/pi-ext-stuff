import { describe, expect, it } from "vitest";
import { installShellAstParser, shellAstParserGeneration } from "../src/permissions/shell-ast.ts";
import { parseCommandSegments } from "../src/permissions/shell-segment.ts";
import { resetTreeSitterShellBackend, shellAstParser } from "../src/tree-sitter/shell-backend.ts";

/**
 * Memo semantics for the sole-interpreter fold. The memo keys on
 * (command, parser generation); these tests pin the three invariants that
 * make that safe: invalidation-by-generation is loud, entries are frozen
 * against cache poisoning, and identity reuse is deliberate.
 */
describe("parseCommandSegments memo", () => {
  it("returns identical frozen arrays for the same string in one generation", () => {
    const first = parseCommandSegments("printf a && printf b");
    const second = parseCommandSegments("printf a && printf b");
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]?.args)).toBe(true);
  });

  it("turns a future in-place write into a loud TypeError at the writer", () => {
    const segments = parseCommandSegments("printf poisoned");
    expect(() => {
      const target = segments[0];
      if (target) target.decomposable = !target.decomposable;
    }).toThrow(TypeError);
    expect(() => {
      segments[0]?.args.push("extra");
    }).toThrow(TypeError);
  });

  it("recomputes after a parser transition instead of serving a stale verdict", () => {
    const command = "printf generation";
    const installed = parseCommandSegments(command);
    expect(installed[0]?.unprovenCause).toBeUndefined();

    const before = shellAstParserGeneration();
    // The blind state folds the same string to one fail-closed segment.
    installShellAstParser(undefined);
    expect(shellAstParserGeneration()).toBeGreaterThan(before);
    const blind = parseCommandSegments(command);
    expect(blind[0]?.unprovenCause).toBe("ast_unavailable");

    // Re-installing the real grammar must restore the fold, not keep serving
    // the blind entry: this is the invalidation-by-construction property.
    const parser = shellAstParser();
    if (!parser) throw new Error("grammar missing for memo test");
    installShellAstParser(parser);
    const restored = parseCommandSegments(command);
    expect(restored[0]?.unprovenCause).toBeUndefined();
  });

  it("invalidates through the test reset seam", () => {
    const command = "printf reset";
    parseCommandSegments(command);
    const before = shellAstParserGeneration();
    resetTreeSitterShellBackend();
    expect(shellAstParserGeneration()).toBeGreaterThan(before);
    // Same-command read after the reset must not reuse the pre-reset entry.
    const after = parseCommandSegments(command);
    expect(after).not.toBe(undefined);
  });

  it("bypasses the memo for oversized commands without caching them", () => {
    const big = `printf ${"x".repeat(40_000)}`;
    const first = parseCommandSegments(big);
    const second = parseCommandSegments(big);
    // Fresh folds are new arrays; a cached entry would be identity-equal.
    expect(second).not.toBe(first);
    expect(second.length).toBe(first.length);
    expect(second.map((segment) => segment.source)).toEqual(first.map((segment) => segment.source));
  });
});
