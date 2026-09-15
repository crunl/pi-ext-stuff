import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
  COMMAND_CONTINUATION_PREFIX,
  WrappedCommandHeader,
} from "../src/tui/bash-command-header.ts";

function leading() {
  return { icon: "X ", verb: "Ran", summary: "" };
}

function plain(header: WrappedCommandHeader, width: number): string[] {
  return header.render(width).map((line) => stripTerminalSequences(line));
}

beforeAll(() => {
  initTheme("dark", false);
});

describe("WrappedCommandHeader", () => {
  it("renders a short command on a single row without a continuation rail", () => {
    const header = new WrappedCommandHeader(0);
    header.setHeader(leading(), "npm test");
    const lines = plain(header, 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("X Ran npm test");
  });

  it("preserves literal newlines as continuation rows under the rail", () => {
    const header = new WrappedCommandHeader(0);
    header.setHeader(leading(), "echo a\necho b\necho c");
    const lines = plain(header, 80);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("X Ran echo a");
    expect(lines[1]).toBe(`${COMMAND_CONTINUATION_PREFIX}echo b`);
    expect(lines[2]).toBe(`${COMMAND_CONTINUATION_PREFIX}echo c`);
  });

  it("caps continuation rows and drops overflow", () => {
    const header = new WrappedCommandHeader(0);
    header.setHeader(leading(), "a\nb\nc\nd\ne");
    const lines = plain(header, 80);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("a");
    expect(lines[1]).toContain("b");
    expect(lines[2]).toContain("c");
    expect(lines.join("\n")).not.toContain("d");
    expect(lines.join("\n")).not.toContain("e");
  });

  it("wraps a long single-line command instead of collapsing it", () => {
    const header = new WrappedCommandHeader(0);
    const cmd = `git commit -m ${"align bash command display ".repeat(4)}`;
    header.setHeader(leading(), cmd);
    const lines = plain(header, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("honors outputPad on every row", () => {
    const header = new WrappedCommandHeader(1);
    header.setHeader(leading(), "echo a\necho b");
    const lines = plain(header, 80);
    expect(lines[0].startsWith(" ")).toBe(true);
    expect(lines[1].startsWith(" ")).toBe(true);
    expect(lines[1]).toContain(COMMAND_CONTINUATION_PREFIX.trim());
  });

  it("renders only the leading when the command is empty", () => {
    const header = new WrappedCommandHeader(0);
    header.setHeader(leading(), "");
    expect(plain(header, 80)).toEqual(["X Ran"]);
  });

  it("does not exceed the width on a very narrow terminal", () => {
    const header = new WrappedCommandHeader(0);
    header.setHeader(leading(), "echo hello-world-this-is-long");
    const lines = plain(header, 8);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(8);
    }
  });

  it("emits ANSI for highlighted bash tokens", () => {
    const header = new WrappedCommandHeader(0);
    header.setHeader(leading(), "git status # note");
    const raw = header.render(80).join("\n");
    expect(raw.includes(String.fromCharCode(27))).toBe(true);
    expect(raw).toContain("[");
  });

  it("reuses cached lines at the same width and rebuilds after invalidate", () => {
    const header = new WrappedCommandHeader(0);
    header.setHeader(leading(), "npm test");
    const a = header.render(80);
    const b = header.render(80);
    expect(a).toBe(b);
    header.invalidate();
    const c = header.render(80);
    expect(c).not.toBe(a);
    expect(c.map(stripTerminalSequences)).toEqual(a.map(stripTerminalSequences));
  });

  it("renders a 20k-char command without stalling", () => {
    const header = new WrappedCommandHeader(0);
    const started = Date.now();
    header.setHeader(leading(), "x".repeat(20_000));
    header.render(100);
    expect(Date.now() - started).toBeLessThan(250);
  });
});
