/**
 * Activation failure path: the host sets `PI_SAFETY_TREE_SITTER_PARSER=1`
 * but the grammar cannot be read. The bridge must report the failure,
 * install nothing, and leave every verdict on the lexer — the shipped
 * path — rather than blocking a request or answering with a half-loaded
 * front end.
 *
 * The `node:fs` mock throws only for the grammar's `.wasm`; everything
 * else (including `web-tree-sitter`'s own module load) reads through to
 * the real filesystem, so the failure exercised here is exactly the one
 * a corrupt or missing grammar produces.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: string | URL | Buffer, options?: unknown) => {
      if (String(path).includes("tree-sitter-bash")) {
        throw new Error("simulated corrupt grammar");
      }
      return actual.readFileSync(path, options as never);
    }) as typeof actual.readFileSync,
  };
});

/** Set by the resolution-failure case below; read by the node:module mock. */
const resolutionFailure = vi.hoisted(() => ({ fail: false }));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: ((specifier: string | URL) => {
      const require = actual.createRequire(specifier);
      return {
        resolve: ((id: string, options?: unknown) => {
          if (resolutionFailure.fail && id === "tree-sitter-bash/package.json") {
            throw new Error("Cannot find module 'tree-sitter-bash/package.json'");
          }
          return require.resolve(id, options as never);
        }) as typeof require.resolve,
      };
    }) as typeof actual.createRequire,
  };
});

import { classifyRiskWithCause, normalizeToolCall } from "../src/permissions/risk.ts";
import { installShellAstParser, shellAstParserInstalled } from "../src/permissions/shell-ast.ts";
import { parseCommandSegments } from "../src/permissions/shell-segment.ts";
import {
  activateTreeSitterShellParser,
  resetTreeSitterShellActivation,
  resetTreeSitterShellBackend,
  TREE_SITTER_PARSER_ENV_FLAG,
  treeSitterShellFailure,
} from "../src/tree-sitter/shell-backend.ts";

describe("tree-sitter activation failure fails closed to the lexer", () => {
  afterEach(() => {
    installShellAstParser(undefined);
    resetTreeSitterShellActivation();
    resetTreeSitterShellBackend();
    resolutionFailure.fail = false;
  });

  it("reports the reason, installs nothing, and never throws", async () => {
    await expect(
      activateTreeSitterShellParser({ [TREE_SITTER_PARSER_ENV_FLAG]: "1" }),
    ).resolves.toBe(false);
    expect(shellAstParserInstalled()).toBe(false);
    const failure = treeSitterShellFailure();
    expect(failure).toBeDefined();
    expect(failure?.message).toBe("simulated corrupt grammar");
  });

  it("leaves the shipped lexer in charge of every verdict", async () => {
    await activateTreeSitterShellParser({
      [TREE_SITTER_PARSER_ENV_FLAG]: "1",
    });
    // A plain command stays decomposable, and the shapes the AST front end
    // tightens stay on the lexer's own verdicts: the broken bridge leaks
    // no partial front-end state into the fold.
    const plain = parseCommandSegments("rm -f /tmp/work");
    expect(plain[0]?.decomposable).toBe(true);
    expect(plain[0]?.unprovenCause).toBeUndefined();
    const truncated = parseCommandSegments("rm -f /tmp/work &&");
    expect(truncated[0]?.decomposable).toBe(true);
    expect(truncated[0]?.unprovenCause).toBeUndefined();
    // The forced-deletion gate is untouched: fail-closed does not depend
    // on the front end.
    const request = normalizeToolCall("bash", { command: "rm -rf /" }, "/work/repo");
    const review = classifyRiskWithCause(request, true);
    expect(review.disposition).toBe("Forbidden");
  });

  it("fails closed when the grammar package root cannot be resolved", async () => {
    resolutionFailure.fail = true;
    await expect(
      activateTreeSitterShellParser({ [TREE_SITTER_PARSER_ENV_FLAG]: "1" }),
    ).resolves.toBe(false);
    expect(shellAstParserInstalled()).toBe(false);
    const failure = treeSitterShellFailure();
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("could not be resolved");
    // The lexer stays in charge of every verdict, synchronously.
    const truncated = parseCommandSegments("rm -f /tmp/x &&");
    expect(truncated[0]?.decomposable).toBe(true);
    expect(truncated[0]?.unprovenCause).toBeUndefined();
  });
});
