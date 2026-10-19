import { homedir } from "node:os";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BASH_GLANCE_BUDGET,
  commandGlance,
  createBashExpandedEvidence,
} from "../src/bash-evidence.ts";

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

describe("commandGlance workspace cd fold", () => {
  const cwd = "/repo";

  it("drops a leading cd into the workspace root", () => {
    expect(commandGlance("cd /repo && npx vitest", BASH_GLANCE_BUDGET, cwd)).toBe("npx vitest");
    expect(commandGlance("cd /repo; npx vitest", BASH_GLANCE_BUDGET, cwd)).toBe("npx vitest");
  });

  it("relativizes a cd below the workspace root but keeps the cd keyword", () => {
    expect(commandGlance("cd /repo/packages/foo && npx vitest", BASH_GLANCE_BUDGET, cwd)).toBe(
      "cd packages/foo && npx vitest",
    );
  });

  it("keeps a cd outside the workspace root", () => {
    expect(commandGlance("cd /tmp && npx vitest", BASH_GLANCE_BUDGET, cwd)).toBe(
      "cd /tmp && npx vitest",
    );
    // `/repo-other` shares the string prefix but not a path segment.
    expect(commandGlance("cd /repo-other && ls", BASH_GLANCE_BUDGET, cwd)).toBe(
      "cd /repo-other && ls",
    );
  });

  it("keeps the cd when no cwd is supplied", () => {
    expect(commandGlance("cd /repo && npx vitest")).toBe("cd /repo && npx vitest");
  });

  it("unquotes a quoted cd target before comparing", () => {
    expect(commandGlance('cd "/repo/packages/foo" && ls', BASH_GLANCE_BUDGET, cwd)).toBe(
      "cd packages/foo && ls",
    );
    expect(commandGlance("cd '/repo' && ls", BASH_GLANCE_BUDGET, cwd)).toBe("ls");
  });

  it("preserves the original separator and its spacing", () => {
    // A `;` written tight against the path must not gain a space in front of it.
    expect(commandGlance("cd /repo/packages/foo; npx vitest", BASH_GLANCE_BUDGET, cwd)).toBe(
      "cd packages/foo; npx vitest",
    );
    expect(commandGlance("cd /repo/packages/foo ; npx vitest", BASH_GLANCE_BUDGET, cwd)).toBe(
      "cd packages/foo ; npx vitest",
    );
  });

  it("collapses redundant slashes in the relativized path", () => {
    // `/repo//foo` resolves to the same directory as `/repo/foo`; the fold must
    // not turn the remainder into a leading-slash (absolute) path.
    expect(commandGlance("cd /repo//foo && ls", BASH_GLANCE_BUDGET, cwd)).toBe("cd foo && ls");
    expect(commandGlance("cd /repo/foo && ls", BASH_GLANCE_BUDGET, cwd)).toBe("cd foo && ls");
  });

  it("folds absolute and relative subdirectory cds to the same glance", () => {
    const absolute = commandGlance("cd /repo/packages/foo && npx vitest", BASH_GLANCE_BUDGET, cwd);
    const relative = commandGlance("cd packages/foo && npx vitest", BASH_GLANCE_BUDGET, cwd);
    expect(absolute).toBe(relative);
    expect(absolute).toBe("cd packages/foo && npx vitest");
  });

  it("expands a ~ target before comparing", () => {
    expect(commandGlance("cd ~/repo && ls", BASH_GLANCE_BUDGET, `${homedir()}/repo`)).toBe("ls");
    expect(commandGlance(`cd ${homedir()}/repo && ls`, BASH_GLANCE_BUDGET, "~/repo")).toBe("ls");
  });

  it("leaves a newline-separated cd untouched", () => {
    expect(commandGlance("cd /repo\nnpx vitest", BASH_GLANCE_BUDGET, cwd)).toBe("cd /repo…");
  });

  it("folds before the budget truncates", () => {
    const long = `cd /repo && ${"x".repeat(80)}`;
    const glance = commandGlance(long, BASH_GLANCE_BUDGET, cwd);
    expect(glance).toBe(`${"x".repeat(BASH_GLANCE_BUDGET)}…`);
  });

  it("folds a workspace cd that alone exceeds the budget", () => {
    const deep = `/repo/${"segment/".repeat(12)}leaf`;
    const glance = commandGlance(`cd ${deep} && ls`, BASH_GLANCE_BUDGET, cwd);
    // The budget lands inside the relative path instead of inside `cd /repo/…`,
    // and the kept `cd ` prefix pushes the visible slice two chars in.
    const folded = `cd ${"segment/".repeat(12)}leaf && ls`;
    expect(glance.startsWith("cd segment/segment/")).toBe(true);
    expect(glance).toBe(`${folded.slice(0, BASH_GLANCE_BUDGET)}…`);
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
