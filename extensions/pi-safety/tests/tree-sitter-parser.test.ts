import { describe, expect, it } from "vitest";
import {
  analyzeShellAst,
  type ShellAstParser,
  type ShellAstTree,
} from "../src/permissions/shell-ast.ts";
import { parseCommandSegments } from "../src/permissions/shell-segment.ts";
import {
  ensureTreeSitterReady,
  resetTreeSitterShellBackend,
  shellAstParser,
  treeSitterShellFailure,
} from "../src/tree-sitter/shell-backend.ts";

/**
 * Counts the trees the adapter was handed and the trees it released.
 *
 * The WASM tree is a native allocation, so "every parse deletes its tree" is the
 * leak guarantee the bridge needs, and the only way to observe it from the pure
 * layer's side is to watch the calls.
 */
function countingParser(inner: ShellAstParser): { parser: ShellAstParser; live(): number } {
  let created = 0;
  let deleted = 0;
  return {
    parser: {
      parse(source: string): ShellAstTree {
        const tree = inner.parse(source);
        created += 1;
        return {
          get rootNode() {
            return tree.rootNode;
          },
          delete(): void {
            deleted += 1;
            tree.delete();
          },
        };
      },
    },
    live: () => created - deleted,
  };
}

describe("tree-sitter shell bridge", () => {
  it("brings the grammar up without throwing and reports no failure", async () => {
    // The barrier's whole contract is that a broken environment degrades instead of
    // exploding: `ensureTreeSitterReady` catches everything it cannot load.
    await expect(ensureTreeSitterReady()).resolves.toBeUndefined();
    expect(treeSitterShellFailure()).toBeUndefined();
  });

  it("parses synchronously into a program root once ready", async () => {
    await ensureTreeSitterReady();
    const parser = shellAstParser();
    expect(parser).toBeDefined();
    if (!parser) return;

    const tracked = countingParser(parser);
    const tree = tracked.parser.parse("git push origin main");
    try {
      expect(tree.rootNode.type).toBe("program");
      expect(tree.rootNode.startIndex).toBe(0);
      expect(tree.rootNode.endIndex).toBeGreaterThan(0);
      expect(tree.rootNode.hasError).toBe(false);
    } finally {
      tree.delete();
    }
    expect(tracked.live()).toBe(0);
  });

  it("releases every tree the adapter takes, on repeated parses", async () => {
    await ensureTreeSitterReady();
    const parser = shellAstParser();
    if (!parser) throw new Error(`bridge unavailable: ${JSON.stringify(treeSitterShellFailure())}`);

    const tracked = countingParser(parser);
    const commands = [
      "git push",
      "echo a && echo b",
      "ls -la | wc -l",
      "FOO=1; git push",
      "echo $(date)",
      "cat < f > out",
      "rm -f $(echo x)",
      "echo hi # trailing",
      // Outside the adapter's model, and malformed: both still release the tree.
      "for i in 1; do echo $i; done",
      "echo $(",
    ];
    for (const command of commands) {
      for (let pass = 0; pass < 3; pass += 1) {
        expect(() => analyzeShellAst(command, tracked.parser)).not.toThrow();
      }
    }
    expect(tracked.live()).toBe(0);
  });

  it("keeps parseCommandSegments a synchronous array on the default path", async () => {
    await ensureTreeSitterReady();
    const result = parseCommandSegments("git push origin main && ls");
    // The ready barrier must never turn the public parser into an async one.
    expect(Array.isArray(result)).toBe(true);
    expect(typeof (result as unknown as Promise<unknown>).then).not.toBe("function");
    expect(result.map((segment) => segment.executable)).toEqual(["git", "ls"]);
  });

  it("stays on the lexer when no parser is installed", () => {
    resetTreeSitterShellBackend();
    expect(shellAstParser()).toBeUndefined();
    // Uninitialized or broken, the shipped path is untouched and still answers.
    const segments = parseCommandSegments("git push");
    expect(segments.map((segment) => segment.executable)).toEqual(["git"]);
  });

  it("swallows a parser that throws instead of failing the request", () => {
    const hostile: ShellAstParser = {
      parse(): ShellAstTree {
        throw new Error("wasm trap");
      },
    };
    expect(analyzeShellAst("git push", hostile)).toBeUndefined();
    expect(() => parseCommandSegments("git push")).not.toThrow();
  });

  it("hands the adapter a tree whose root it can read", async () => {
    await ensureTreeSitterReady();
    const parser = shellAstParser();
    if (!parser) throw new Error("bridge unavailable");
    const analysis = analyzeShellAst("echo hi # trailing", parser);
    expect(analysis).toBeDefined();
    // A command this phase models must produce at least the source's own statement.
    expect(analysis?.segments.length).toBeGreaterThan(0);
    expect(analysis?.hadError).toBe(false);
  });
});
