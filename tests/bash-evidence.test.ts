import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BASH_GLANCE_BUDGET,
  commandGlance,
  createBashExpandedEvidence,
} from "../src/tui/bash-evidence.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

beforeAll(() => {
  initTheme("dark", false);
});

describe("commandGlance", () => {
  it("returns a short single-line command unchanged", () => {
    expect(commandGlance("npm test")).toBe("npm test");
  });

  it("keeps only the first logical line and marks omitted lines with ellipsis", () => {
    expect(commandGlance("echo a\necho b\necho c")).toBe("echo a…");
  });

  it("caps long single-line commands at the glance budget", () => {
    const long = `cd /tmp && ${"x".repeat(80)}`;
    const glance = commandGlance(long);
    expect(glance.endsWith("…")).toBe(true);
    expect(glance.length).toBe(BASH_GLANCE_BUDGET + 1);
  });

  it("handles empty and whitespace-only commands", () => {
    expect(commandGlance("")).toBe("");
    expect(commandGlance("\n\n")).toBe("");
  });
});

describe("createBashExpandedEvidence", () => {
  it("renders full command under the rail then output", () => {
    const component = createBashExpandedEvidence({
      command: "echo a\necho b",
      outputText: "a\nb",
      theme,
      outputPad: 0,
      isError: false,
    });
    const lines = component.render(100).map((line) => stripTerminalSequences(line));
    expect(lines.some((line) => line.includes("$ ") && line.includes("echo a"))).toBe(true);
    expect(lines.some((line) => line.includes("echo b"))).toBe(true);
    expect(lines.some((line) => line.includes("└") && line.includes("a"))).toBe(true);
  });

  it("wraps long command evidence lines under the rail within width", () => {
    const long = `cd /Users/x1a2h1/workspace/edgeone/agentic && echo "pad" && ${"grep -rn xai cloud-functions; ".repeat(4)}ls`;
    const component = createBashExpandedEvidence({
      command: long,
      outputText: "ok",
      theme,
      outputPad: 0,
      isError: false,
    });
    const width = 48;
    const lines = component.render(width).map((line) => stripTerminalSequences(line));
    const commandRows = lines.filter((line) => line.includes("│"));
    expect(commandRows.length).toBeGreaterThan(1);
    expect(commandRows[0]).toContain("$ ");
    expect(commandRows[1].startsWith("  │   ") || commandRows[1].startsWith("  │ ")).toBe(true);
    for (const row of commandRows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
  });
});
