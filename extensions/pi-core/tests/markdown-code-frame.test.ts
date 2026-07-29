import { Markdown } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { applyMarkdownCodeFrame, resetMarkdownCodeFrame } from "../src/tui/markdown-code-frame.ts";

// Zero-width ANSI markers (like real themes); visible prefixes would
// distort width math since Markdown.render re-wraps at contentWidth.
const B_ON = "\x1b[31m";
const B_OFF = "\x1b[39m";
const C_ON = "\x1b[32m";
const C_OFF = "\x1b[39m";

const plainTheme = {
  heading: (t: string) => t,
  link: (t: string) => t,
  linkUrl: (t: string) => t,
  code: (t: string) => t,
  codeBlock: (t: string) => `${C_ON}${t}${C_OFF}`,
  codeBlockBorder: (t: string) => `${B_ON}${t}${B_OFF}`,
  quote: (t: string) => t,
  quoteBorder: (t: string) => t,
  hr: (t: string) => t,
  listBullet: (t: string) => t,
  bold: (t: string) => t,
  italic: (t: string) => t,
  strikethrough: (t: string) => t,
  underline: (t: string) => t,
} as const;

function renderMarkdown(text: string, theme: object = plainTheme, width = 40): string[] {
  const md = new Markdown(text, 0, 0, theme as never);
  return md.render(width).map((line) => line.trimEnd());
}

/** Strip ANSI escapes for structural assertions. */
function plain(line: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

const FENCED = "```ts\nconst x = 1;\n```";

describe("applyMarkdownCodeFrame", () => {
  afterEach(() => {
    resetMarkdownCodeFrame();
  });

  it("replaces raw fences with a closed rounded frame and language label", () => {
    applyMarkdownCodeFrame();
    const lines = renderMarkdown(FENCED);

    expect(lines.join("\n")).not.toContain("```");
    expect(lines[0]).toContain("╭─ ts ");
    expect(lines[0]).toContain("╮");
    expect(lines[1]).toContain("│ ");
    expect(lines[1]).toContain("const x = 1;");
    expect(plain(lines[1]).trimEnd().endsWith("│")).toBe(true); // right border closed
    expect(lines[2]).toContain("╰");
    expect(lines[2]).toContain("╯");
  });

  it("renders a plain top border when no language is given", () => {
    applyMarkdownCodeFrame();
    const lines = renderMarkdown("```\ncode\n```");
    expect(lines[0]).toContain("╭");
    expect(lines[0]).not.toContain("╭─ ");
  });

  it("styles borders via codeBlockBorder and code via codeBlock", () => {
    applyMarkdownCodeFrame();
    const lines = renderMarkdown(FENCED);
    expect(lines[0]).toContain(B_ON);
    expect(lines[1]).toContain(`${C_ON}const x = 1;${C_OFF}`);
  });

  it("uses highlightCode when the theme provides it", () => {
    applyMarkdownCodeFrame();
    const theme = {
      ...plainTheme,
      highlightCode: (code: string) => code.split("\n").map((l) => `\x1b[35m${l}\x1b[39m`),
    };
    const lines = renderMarkdown(FENCED, theme);
    expect(lines[1]).toContain("\x1b[35mconst x = 1;\x1b[39m");
  });

  it("wraps long code lines inside the closed frame", () => {
    applyMarkdownCodeFrame();
    const longLine = "x".repeat(60);
    const lines = renderMarkdown(`\`\`\`\n${longLine}\n\`\`\``, plainTheme, 40);
    const railRows = lines.filter((l) => l.includes("│ "));
    expect(railRows.length).toBeGreaterThan(1); // wrapped continuation keeps rail
    for (const row of railRows) {
      expect(plain(row).trimEnd().endsWith("│")).toBe(true); // every row closes right
    }
  });

  it("leaves non-code markdown untouched", () => {
    const before = renderMarkdown("# Title\n\nplain *text*");
    applyMarkdownCodeFrame();
    const after = renderMarkdown("# Title\n\nplain *text*");
    expect(after).toEqual(before);
  });

  it("is idempotent", () => {
    applyMarkdownCodeFrame();
    applyMarkdownCodeFrame();
    const lines = renderMarkdown(FENCED);
    expect(lines.filter((l) => l.includes("╭")).length).toBe(1);
  });

  it("falls back to original fences when the frame renderer throws", () => {
    applyMarkdownCodeFrame();
    let calls = 0;
    const theme = {
      ...plainTheme,
      // Throws only for the frame renderer (first call); the original
      // fence branch calls it again and succeeds.
      highlightCode: (code: string) => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return code.split("\n");
      },
    };
    const lines = renderMarkdown(FENCED, theme);
    expect(lines.join("\n")).toContain("```"); // original branch took over
  });

  it("reset restores the original fence rendering", () => {
    applyMarkdownCodeFrame();
    resetMarkdownCodeFrame();
    const lines = renderMarkdown(FENCED);
    expect(lines.join("\n")).toContain("```ts");
  });
});
