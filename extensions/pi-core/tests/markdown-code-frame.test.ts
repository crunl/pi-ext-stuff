import { Markdown } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { applyMarkdownCodeFrame, resetMarkdownCodeFrame } from "../src/tui/markdown-code-frame.ts";

// Zero-width ANSI markers (like real themes); visible prefixes would
// distort width math since Markdown.render re-wraps at contentWidth.
const C_ON = "\x1b[32m";
const C_OFF = "\x1b[39m";

const plainTheme = {
  heading: (t: string) => t,
  link: (t: string) => t,
  linkUrl: (t: string) => t,
  code: (t: string) => t,
  codeBlock: (t: string) => `${C_ON}${t}${C_OFF}`,
  codeBlockBorder: (t: string) => t,
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

  it("renders pure highlighted content with no fences, label, or indent", () => {
    applyMarkdownCodeFrame();
    const lines = renderMarkdown(FENCED);

    const joined = lines.join("\n");
    expect(joined).not.toContain("```");
    expect(joined).not.toContain("╭");
    expect(joined).not.toContain("ts");
    expect(plain(lines[0])).toBe("const x = 1;");
  });

  it("falls back to theme.codeBlock when highlightCode is absent", () => {
    applyMarkdownCodeFrame();
    const lines = renderMarkdown(FENCED);
    expect(lines[0]).toContain(`${C_ON}const x = 1;${C_OFF}`);
  });

  it("uses highlightCode when the theme provides it", () => {
    applyMarkdownCodeFrame();
    const theme = {
      ...plainTheme,
      highlightCode: (code: string) => code.split("\n").map((l) => `\x1b[35m${l}\x1b[39m`),
    };
    const lines = renderMarkdown(FENCED, theme);
    expect(lines[0]).toContain("\x1b[35mconst x = 1;\x1b[39m");
  });

  it("keeps content rows copy-safe: no rails, indent, or trailing pad", () => {
    applyMarkdownCodeFrame();
    const lines = renderMarkdown("```ts\nconst x = 1;\nconst y = 2;\n```");
    for (const line of lines) {
      const text = plain(line);
      expect(text).not.toContain("│");
      expect(text).not.toContain("╭");
      expect(text.trimEnd()).toBe(text);
    }
    expect(plain(lines[0])).toBe("const x = 1;");
    expect(plain(lines[1])).toBe("const y = 2;");
  });

  it("wraps long code lines at full width", () => {
    applyMarkdownCodeFrame();
    const longLine = "x".repeat(60);
    const lines = renderMarkdown(`\`\`\`\n${longLine}\n\`\`\``, plainTheme, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const row of lines) {
      expect(plain(row).length).toBeLessThanOrEqual(40);
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
    expect(lines.filter((l) => plain(l) === "const x = 1;").length).toBe(1);
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
