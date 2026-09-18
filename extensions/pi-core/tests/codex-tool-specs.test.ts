import { homedir } from "node:os";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
  codexBashToolSpec,
  codexEditToolSpec,
  codexFindToolSpec,
  codexGrepToolSpec,
  codexLsToolSpec,
  codexReadToolSpec,
  codexWriteToolSpec,
  commandGlance,
  displayPath,
  summarizeBashOutput,
  summarizeEditDiff,
} from "../src/tui/codex-tool-specs.ts";
import { type CodexToolRendererSpec, createCodexToolRendering } from "../src/tui/tool-renderer.ts";

beforeAll(() => {
  initTheme("dark", false);
});

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    args: {} as Record<string, unknown>,
    toolCallId: "t1",
    invalidate: () => {},
    state: {},
    cwd: "/repo",
    isError: false,
    expanded: false,
    ...overrides,
  };
}

const padSource = { getOutputPad: () => 0, track() {} } as never;

function renderBashLifecycle(options: {
  args: Record<string, unknown>;
  resultText?: string;
  isPartial?: boolean;
  isError?: boolean;
  expanded?: boolean;
}) {
  const rendering = createCodexToolRendering(codexBashToolSpec, padSource);
  const ctx = context({
    args: options.args,
    isError: options.isError ?? false,
    expanded: options.expanded ?? false,
  });
  const header = rendering.renderCall(options.args, theme as never, ctx as never);
  const result = rendering.renderResult(
    {
      content:
        options.resultText === undefined
          ? []
          : [{ type: "text" as const, text: options.resultText }],
    } as never,
    {
      expanded: options.expanded ?? false,
      isPartial: options.isPartial ?? false,
    },
    theme as never,
    ctx as never,
  );
  return {
    headerLines: () => header.render(120).map((line) => stripTerminalSequences(line)),
    rawHeader: () => header.render(120).join("\n"),
    resultLines: () => result.render(120).map((line) => stripTerminalSequences(line)),
  };
}

describe("codex tool specs", () => {
  it.each([
    ["read", codexReadToolSpec, "\uF15C"],
    ["grep", codexGrepToolSpec, "\uF0B0"],
    ["find", codexFindToolSpec, "\uF002"],
    ["ls", codexLsToolSpec, "\uF07B"],
    ["bash", codexBashToolSpec, "\uF155"],
    ["write", codexWriteToolSpec, "\uEE38"],
    ["edit", codexEditToolSpec, "\uEE3C"],
  ] as const)("%s uses the selected single-column Font Awesome icon", (_name, spec, icon) => {
    expect(spec.icon).toBe(icon);
    expect(visibleWidth(icon)).toBe(1);
  });

  it("edit spec renders Editing header with a +N -M summary", () => {
    const rendering = createCodexToolRendering(codexEditToolSpec, padSource);
    const args = { path: "src/a.ts" };
    const ctx = context({ args });
    const running = rendering.renderCall(args, theme as never, ctx as never);
    const runningText = stripTerminalSequences(running.render(100).join("\n"));
    expect(runningText).toContain("Editing src/a.ts");
    expect(runningText).toContain("▶");

    rendering.renderResult(
      {
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/a.ts." }],
        details: { diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n-a\n+b\n+c" },
      } as never,
      { expanded: false, isPartial: false },
      theme as never,
      ctx as never,
    );
    const completed = rendering.renderCall(args, theme as never, ctx as never);
    const text = stripTerminalSequences(completed.render(100).join("\n"));
    expect(text).toContain("Edited src/a.ts");
    expect(text).toContain("+2 -1");
    expect(text).toContain("▶");
  });

  it("edit expanded header switches chevron to ▼", () => {
    const rendering = createCodexToolRendering(codexEditToolSpec, padSource);
    const args = { path: "src/a.ts" };
    const ctx = context({ args, expanded: true });
    rendering.renderCall(args, theme as never, ctx as never);
    const result = rendering.renderResult(
      {
        content: [{ type: "text", text: "ok" }],
        details: { diff: "  1 context\n-2 old\n+2 new" },
      } as never,
      { expanded: true, isPartial: false },
      theme as never,
      ctx as never,
    );
    const header = stripTerminalSequences(
      rendering
        .renderCall(args, theme as never, ctx as never)
        .render(100)
        .join("\n"),
    );
    expect(header).toContain("Edited src/a.ts");
    expect(header).toContain("▼");
    expect(header).not.toContain("▶");
    const body = result.render(100).map((row) => stripTerminalSequences(row));
    expect(body.length).toBeGreaterThan(0);
  });

  it("write spec collapses to the header with a green +N line summary", () => {
    const rendering = createCodexToolRendering(codexWriteToolSpec, padSource);
    const args = { path: "note.txt", content: "a\nb\n" };
    const ctx = context({ args });
    const header = rendering.renderCall(args, theme as never, ctx as never);
    rendering.renderResult(
      { content: [{ type: "text", text: "ok" }] } as never,
      { expanded: false, isPartial: false },
      theme as never,
      ctx as never,
    );
    const text = header.render(100).join("\n");
    expect(text).toContain(" Wrote note.txt");
    expect(text).toContain("+2");
  });

  it("read settled header is path · N lines + chevron with empty body", () => {
    const rendering = createCodexToolRendering(codexReadToolSpec, padSource);
    const args = { path: "/repo/src/a.ts" };
    const ctx = context({ args });
    const header = rendering.renderCall(args, theme as never, ctx as never);
    const result = rendering.renderResult(
      { content: [{ type: "text", text: "a\nb\nc" }] } as never,
      { expanded: false, isPartial: false },
      theme as never,
      ctx as never,
    );
    const line = stripTerminalSequences(header.render(100).join("\n"));
    expect(line).toContain("Read /repo/src/a.ts");
    expect(line).toContain("· 3 lines");
    expect(line).toContain("▶");
    expect(result.render(100)).toEqual([]);
  });

  it("read expanded body uses line-number gutter, not the bash \u2514 rail", () => {
    const rendering = createCodexToolRendering(codexReadToolSpec, padSource);
    const args = { path: "/repo/src/a.ts", offset: 10, limit: 3 };
    const ctx = context({ args, expanded: true, isError: false });
    const header = rendering.renderCall(args, theme as never, ctx as never);
    const result = rendering.renderResult(
      { content: [{ type: "text", text: "line ten\nline eleven\nline twelve\n" }] } as never,
      { expanded: true, isPartial: false },
      theme as never,
      ctx as never,
    );
    expect(stripTerminalSequences(header.render(100).join("\n"))).toContain("▼");
    const body = result.render(100).map((row) => stripTerminalSequences(row));
    const joined = body.join("\n");
    expect(joined).toContain("10 │");
    expect(joined).toContain("11 │");
    expect(joined).not.toContain("└");
  });

  it("read failed expanded stays on the error rail without file gutter", () => {
    const rendering = createCodexToolRendering(codexReadToolSpec, padSource);
    const args = { path: "/repo/missing.md" };
    const ctx = context({ args, isError: true, expanded: true });
    const header = rendering.renderCall(args, theme as never, ctx as never);
    const result = rendering.renderResult(
      { content: [{ type: "text", text: "ENOENT: no such file" }] } as never,
      { expanded: true, isPartial: false },
      theme as never,
      ctx as never,
    );
    expect(stripTerminalSequences(header.render(100).join("\n"))).toContain("▼");
    const joined = result
      .render(100)
      .map((row) => stripTerminalSequences(row))
      .join("\n");
    expect(joined).toContain("ENOENT");
    expect(joined).not.toMatch(/\d+\s+│/u);
  });

  it("read failed keeps error rail without line summary", () => {
    const rendering = createCodexToolRendering(codexReadToolSpec, padSource);
    const args = { path: "/repo/missing.md" };
    const ctx = context({ args, isError: true });
    const header = rendering.renderCall(args, theme as never, ctx as never);
    const result = rendering.renderResult(
      { content: [{ type: "text", text: "ENOENT: no such file" }] } as never,
      { expanded: false, isPartial: false },
      theme as never,
      ctx as never,
    );
    const line = stripTerminalSequences(header.render(100).join("\n"));
    expect(line).toContain("Failed");
    expect(line).not.toMatch(/·\s+\d+\s+lines?/u);
    const body = result.render(100).map((row) => stripTerminalSequences(row));
    expect(body.join("\n")).toContain("ENOENT");
  });

  it("bash glance header is one row with verb, command start, and output summary", () => {
    const { headerLines, rawHeader } = renderBashLifecycle({
      args: { command: "npm test" },
      resultText: "ok\nmore\nlines",
    });
    const lines = headerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ran npm test");
    expect(lines[0]).toContain("· 3 output lines");
    expect(lines[0]).toContain("▶");
    // Glance command carries shell highlight ANSI (not plain muted-only).
    expect(rawHeader().includes(String.fromCharCode(27))).toBe(true);
  });

  it("bash long single-line command keeps summary after glance budget + chevron", () => {
    const command = `cd /Users/x1a2h1/workspace/edgeone/agentic && ${"echo x; ".repeat(20)}ls`;
    const { headerLines } = renderBashLifecycle({
      args: { command },
      resultText: "a\nb\nc",
    });
    const line = headerLines()[0];
    expect(line).toContain("Ran");
    expect(line).toContain("…");
    expect(line).toContain("· 3 output lines");
    expect(line).toContain("▶");
    expect(line.indexOf("· 3 output lines")).toBeGreaterThan(line.indexOf("…"));
  });

  it("bash multiline command glance collapses to a single header row with ellipsis", () => {
    const command = 'cd /tmp && echo "== xai =="; grep -rn "xai" . | head; sed -n "1,5p" f';
    const { headerLines } = renderBashLifecycle({
      args: { command: `${command}\necho more` },
      resultText: "a\nb",
    });
    const lines = headerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ran");
    expect(lines[0]).toContain("…");
    expect(lines[0]).toContain("· 2 output lines");
    expect(lines[0]).toContain("▶");
    expect(lines.join("\n")).not.toContain("│");
  });

  it("bash success with empty output shows no-output summary and no body", () => {
    const { headerLines, resultLines } = renderBashLifecycle({
      args: { command: "true" },
      resultText: "(no output)",
    });
    expect(headerLines()[0]).toContain("Ran true");
    expect(headerLines()[0]).toContain("· no output");
    expect(headerLines()[0]).toContain("▶");
    expect(resultLines()).toEqual([]);
  });

  it("bash running header omits the output-line summary but keeps chevron", () => {
    const { headerLines } = renderBashLifecycle({
      args: { command: "npm test" },
      resultText: "partial",
      isPartial: true,
    });
    const text = headerLines().join("\n");
    expect(text).toContain("Running npm test");
    expect(text).not.toContain("output line");
    expect(text).toContain("▶");
  });

  it("bash failed header uses Command failed and keeps an error preview", () => {
    const { headerLines, resultLines } = renderBashLifecycle({
      args: { command: "npm test" },
      resultText: "FAIL b\nCommand exited with code 1",
      isError: true,
    });
    expect(headerLines()[0]).toContain("Command failed npm test");
    expect(headerLines()[0]).toContain("· 2 output lines");
    expect(headerLines()[0]).toContain("▶");
    const body = resultLines().join("\n");
    expect(body).toContain("Command exited with code 1");
  });

  it("bash expanded body shows full command evidence then output", () => {
    const { headerLines, resultLines } = renderBashLifecycle({
      args: { command: "echo a\necho b" },
      resultText: "a\nb",
      expanded: true,
    });
    expect(headerLines()[0]).toContain("Ran echo a…");
    expect(headerLines()[0]).toContain("▼");
    expect(headerLines()[0]).not.toContain("▶");
    const body = resultLines().join("\n");
    expect(body).toContain("$ ");
    expect(body).toContain("echo b");
    expect(body).toContain("└");
  });

  it("bash failed expanded keeps glance header and full command evidence", () => {
    const { headerLines, resultLines } = renderBashLifecycle({
      args: { command: "npm test\necho more" },
      resultText: "FAIL\nCommand exited with code 1",
      isError: true,
      expanded: true,
    });
    expect(headerLines()).toHaveLength(1);
    expect(headerLines()[0]).toContain("Command failed");
    expect(headerLines()[0]).toContain("…");
    expect(headerLines()[0]).toContain("▼");
    const body = resultLines().join("\n");
    expect(body).toContain("$ ");
    expect(body).toContain("npm test");
    expect(body).toContain("echo more");
    expect(body).toContain("Command exited with code 1");
  });

  it("bash success collapsed is header-only (no preview body)", () => {
    const { headerLines, resultLines } = renderBashLifecycle({
      args: { command: "seq 1 8" },
      resultText: Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"),
    });
    expect(headerLines()[0]).toContain("· 8 output lines");
    expect(headerLines()[0]).toContain("▶");
    expect(resultLines()).toEqual([]);
  });

  it("bash failed collapsed keeps an error preview capped at failedOutputRows", () => {
    const { headerLines, resultLines } = renderBashLifecycle({
      args: { command: "seq 1 20" },
      resultText: Array.from({ length: 20 }, (_, index) => `err ${index + 1}`).join("\n"),
      isError: true,
    });
    expect(headerLines()[0]).toContain("Command failed");
    const rows = resultLines();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(8);
  });
});

describe("displayPath", () => {
  it("rewrites the home prefix to ~ and leaves other paths alone", () => {
    expect(displayPath("/Users/alice/.pi/x.md", "/Users/alice")).toBe("~/.pi/x.md");
    expect(displayPath("/Users/alice", "/Users/alice")).toBe("~");
    expect(displayPath("/Users/alice2/x.md", "/Users/alice")).toBe("/Users/alice2/x.md");
    expect(displayPath("/tmp/x.md", "/Users/alice")).toBe("/tmp/x.md");
    expect(displayPath("", "/Users/alice")).toBe("");
  });

  it("uses the live homedir for tool headers", () => {
    const home = homedir();
    const path = `${home}/.pi/agent/skills/code-review/SKILL.md`;
    const rendering = createCodexToolRendering(codexReadToolSpec, padSource);
    const args = { path };
    const ctx = context({ args });
    const header = rendering.renderCall(args, theme as never, ctx as never);
    rendering.renderResult(
      { content: [{ type: "text", text: "ok" }] } as never,
      { expanded: false, isPartial: false },
      theme as never,
      ctx as never,
    );
    const text = header.render(100).join("\n");
    expect(text).toContain("Read ~/.pi/agent/skills/code-review/SKILL.md");
    expect(text).not.toContain(home);
  });

  it("keeps the home prefix when offset/limit append a range", () => {
    const home = homedir();
    const rendering = createCodexToolRendering(codexReadToolSpec, padSource);
    const args = { path: `${home}/src/a.ts`, offset: 10, limit: 5 };
    const ctx = context({ args });
    const header = rendering.renderCall(args, theme as never, ctx as never);
    rendering.renderResult(
      { content: [{ type: "text", text: "ok" }] } as never,
      { expanded: false, isPartial: false },
      theme as never,
      ctx as never,
    );
    expect(header.render(100).join("\n")).toContain("Read ~/src/a.ts:10-14");
  });
});

describe("summarizeEditDiff", () => {
  it("counts additions and deletions without counting diff headers", () => {
    expect(
      summarizeEditDiff({
        content: [],
        details: {
          diff: [
            "--- a/file.ts",
            "+++ b/file.ts",
            "@@ -1,2 +1,3 @@",
            "-old",
            "+new",
            "+added",
            " unchanged",
          ].join("\n"),
        },
      } as never),
    ).toBe("+2 -1");
  });
});

describe("commandGlance / summarizeBashOutput", () => {
  it("glance marks multiline commands and budgets long singles", () => {
    expect(commandGlance("npm test")).toBe("npm test");
    expect(commandGlance("echo a\necho b")).toBe("echo a…");
    expect(commandGlance("x".repeat(60)).endsWith("…")).toBe(true);
  });

  function bashResult(text: string) {
    return { content: [{ type: "text" as const, text }] } as never;
  }

  it("pluralizes output line counts and ignores blank/status spacing noise", () => {
    expect(summarizeBashOutput(bashResult("a\nb\nc"), {}, { isError: false })).toBe(
      "3 output lines",
    );
    expect(summarizeBashOutput(bashResult("only"), {}, { isError: false })).toBe("1 output line");
    expect(
      summarizeBashOutput(bashResult("a\n\n\nCommand exited with code 0"), {}, { isError: false }),
    ).toBe("2 output lines");
  });

  it("treats Pi's (no output) placeholder as empty success output", () => {
    expect(summarizeBashOutput(bashResult("(no output)"), {}, { isError: false })).toBe(
      "no output",
    );
  });

  it("keeps failed counts but omits no-output on failure", () => {
    expect(
      summarizeBashOutput(bashResult("boom\nCommand exited with code 1"), {}, { isError: true }),
    ).toBe("2 output lines");
    expect(summarizeBashOutput(bashResult(""), {}, { isError: true })).toBeUndefined();
  });
});

describe("CodexToolRendererSpec type surface", () => {
  it("bash spec exposes glance + summary contract fields", () => {
    const spec: CodexToolRendererSpec = codexBashToolSpec;
    expect(spec.failedVerb).toBe("Command failed");
    expect(spec.singleLineHeader).toBe(true);
    expect(typeof spec.summarizeResult).toBe("function");
    expect(spec.failedOutputRows).toBe(8);
    expect(spec.expandedResultOnFailed).toBe(true);
    expect(spec.showExpandIndicator).toBe(true);
  });

  it("read spec exposes file-evidence contract fields", () => {
    const spec: CodexToolRendererSpec = codexReadToolSpec;
    expect(spec.singleLineHeader).toBe(true);
    expect(spec.showExpandIndicator).toBe(true);
    expect(typeof spec.summarizeResult).toBe("function");
    expect(typeof spec.renderExpandedResult).toBe("function");
    expect(spec.expandedResultOnFailed).toBeFalsy();
  });

  it("edit spec exposes expand chevron with diff summary", () => {
    const spec: CodexToolRendererSpec = codexEditToolSpec;
    expect(spec.singleLineHeader).toBe(true);
    expect(spec.showExpandIndicator).toBe(true);
    expect(typeof spec.collapsed).toBe("function");
    expect(typeof spec.renderExpandedResult).toBe("function");
  });
});
