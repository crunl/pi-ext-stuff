import { describe, expect, it } from "vitest";
import {
  extractScriptOutput,
  stripScriptHeader,
  summarizeCallArgs,
  toTreeView,
} from "../src/tui/codemode-contract.ts";

/** 0.99.1-shaped payloads. Keep in sync when the upstream pin moves. */
const detailFixture = {
  calls: [
    {
      id: "call-1/1",
      name: "bash",
      args: '{"command":"ls"}',
      status: "ok",
      durationMs: 129,
    },
    {
      id: "call-1/2",
      name: "mcp__exa__web_search",
      args: '{"query":"pi codemode"}',
      status: "error",
      error: "boom",
    },
  ],
  fullOutputPath: "/tmp/out.txt",
};

describe("stripScriptHeader", () => {
  it("drops completed and failed headers", () => {
    expect(stripScriptHeader("Script completed\nWall time 0.1 seconds\nOutput:\nbody")).toBe(
      "body",
    );
    expect(stripScriptHeader("Script failed\nWall time 2.5 seconds\nOutput:\n")).toBe("");
  });

  it("passes through text without a Script header", () => {
    expect(stripScriptHeader("plain output")).toBe("plain output");
  });
});

describe("extractScriptOutput", () => {
  it("joins text blocks and strips the header prefix", () => {
    const output = extractScriptOutput({
      content: [
        { type: "text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
        { type: "text", text: "result-body" },
      ],
    });
    expect(output).toBe("result-body");
  });
});

describe("summarizeCallArgs", () => {
  it("prefers command/path over raw JSON", () => {
    expect(summarizeCallArgs("bash", '{"command":"ls -la"}')).toBe("ls -la");
    expect(summarizeCallArgs("read", '{"path":"package.json"}')).toBe("package.json");
  });

  it("falls back safely when args JSON is truncated or invalid", () => {
    expect(() => summarizeCallArgs("bash", '{"command":"ls"}…')).not.toThrow();
    expect(summarizeCallArgs("bash", '{"command":"ls"}…')).toContain("command");
  });
});

describe("toTreeView", () => {
  it("maps a 0.99.1-shaped details payload", () => {
    const view = toTreeView({
      details: detailFixture,
      args: { code: "await tools.bash({ command: 'ls' })\n// more\n// lines" },
      result: {
        content: [
          { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
          { type: "text", text: '{"ok":true}' },
        ],
      },
    });
    expect(view.glance).toMatchObject({
      total: 2,
      commands: 1,
      other: 1,
      failed: 1,
    });
    expect(view.children[0]?.toolLabel).toBe("bash");
    expect(view.children[1]?.toolLabel).toBe("exa / web_search");
    expect(view.children[1]?.errorText).toBe("boom");
    expect(view.code?.lineCount).toBe(3);
    expect(view.output?.preview).toContain("ok");
    expect(view.fullOutputPath).toBe("/tmp/out.txt");
    expect(view.capabilities.childResultPreview).toBe(false);
  });

  it("ignores unknown fields and never throws on dirty payloads", () => {
    const view = toTreeView({
      details: {
        calls: [
          { id: "a", name: "read", status: "weird-future-status", extra: { nested: true } },
          { notACall: true },
          "garbage",
        ],
        futureField: 1,
      },
      args: null,
      result: { content: [{ type: "image", data: "x", mimeType: "image/png" }] },
      isPartial: true,
    });
    expect(view.children).toHaveLength(3);
    expect(view.children[0]?.status).toBe("unknown");
    expect(view.children[1]?.id).toBe("call:1");
    expect(view.code).toBeNull();
    expect(view.output).toBeNull();
    expect(view.capabilities.childResultPreview).toBe(false);
  });

  it("flags childResultPreview when upstream grows the field", () => {
    const view = toTreeView({
      details: {
        calls: [{ id: "a", name: "bash", args: "{}", status: "ok", resultPreview: "out" }],
      },
      args: {},
    });
    expect(view.capabilities.childResultPreview).toBe(true);
  });
});
