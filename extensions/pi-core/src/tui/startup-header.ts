/**
 * startup-header — custom new-session header via chafa image render.
 *
 * Source art: assets/huawei-logo.png (Wikimedia “Huawei Standard logo”,
 * rasterized for chafa). See assets/SOURCE.md.
 *
 * Renders with `chafa` into ANSI symbol rows at session_start. Cached by
 * target width. Logo only — no wordmark/version. If chafa is missing or
 * fails, the header stays empty (same as quietStartup).
 *
 * Shown on startup / new / reload; cleared on resume / fork.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const SHOW_REASONS = new Set(["startup", "new", "reload"]);

/** Preferred chafa cell size (cols x rows). Rows stay compact for the header. */
const LOGO_COLS = 36;
const LOGO_ROWS = 14;

export function shouldShowStartupHeader(reason: string): boolean {
  return SHOW_REASONS.has(reason);
}

export function getLogoAssetPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/tui -> ../../assets
  return path.resolve(here, "../../assets/huawei-logo.png");
}

/** Resolve chafa binary; null if unavailable. */
export function resolveChafaBin(): string | null {
  const candidates = ["chafa", "/opt/homebrew/bin/chafa", "/usr/local/bin/chafa"];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 1500 });
      return bin;
    } catch {
      // try next
    }
  }
  return null;
}

const ESC = "\u001b";
// ESC + CSI params; bracket must be double-escaped for RegExp source.
const ANSI_SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

/** True if a line has any visible (non-space) content after stripping ANSI. */
export function lineHasInk(line: string): boolean {
  const plain = line.replace(ANSI_SGR, "").replace(ANSI_CSI, "");
  return plain.trim().length > 0;
}

/** Drop leading/trailing blank (no-ink) rows from chafa output. */
export function trimInkLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end) {
    const row = lines[start];
    if (row !== undefined && lineHasInk(row)) break;
    start++;
  }
  while (end > start) {
    const row = lines[end - 1];
    if (row !== undefined && lineHasInk(row)) break;
    end--;
  }
  return lines.slice(start, end);
}

export function centerLine(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w >= width) return line;
  return `${" ".repeat(Math.floor((width - w) / 2))}${line}`;
}

/**
 * Render the logo PNG through chafa into terminal rows.
 * Returns null on any failure (missing bin/asset/nonzero exit).
 */
export function renderLogoWithChafa(options?: {
  bin?: string | null;
  assetPath?: string;
  cols?: number;
  rows?: number;
}): string[] | null {
  const bin = options?.bin === undefined ? resolveChafaBin() : options.bin;
  if (!bin) return null;
  const assetPath = options?.assetPath ?? getLogoAssetPath();
  if (!existsSync(assetPath)) return null;
  const cols = options?.cols ?? LOGO_COLS;
  const rows = options?.rows ?? LOGO_ROWS;
  try {
    const out = execFileSync(
      bin,
      [
        "--format",
        "symbols",
        "--colors",
        "full",
        "--symbols",
        "block",
        "--size",
        `${cols}x${rows}`,
        "--relative",
        "off",
        "--polite",
        "on",
        "--fg-only",
        assetPath,
      ],
      {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 256 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const lines = trimInkLines(out.split(/\r?\n/));
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

/**
 * Build header lines: centered chafa logo only (no wordmark/version).
 * Pure enough for tests when logoLines is injected.
 */
export function buildStartupHeaderLines(
  width: number,
  options?: { logoLines?: string[] | null },
): string[] {
  const logo =
    options && "logoLines" in options
      ? options.logoLines
      : renderLogoWithChafa({ cols: Math.min(LOGO_COLS, Math.max(24, width - 4)) });

  if (!logo || logo.length === 0) return [];

  const lines: string[] = [""];
  for (const row of logo) {
    lines.push(centerLine(row, width));
  }
  lines.push("");
  return lines;
}

/** Install the header on session_start. */
export function registerStartupHeader(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    if (!shouldShowStartupHeader(event.reason)) {
      ctx.ui.setHeader(undefined);
      return;
    }

    // Pre-render once per session at a stable size; render() only centers.
    const logoLines = renderLogoWithChafa();
    if (!logoLines) {
      ctx.ui.setHeader(undefined);
      return;
    }

    ctx.ui.setHeader(() => {
      let cached: { width: number; lines: string[] } | undefined;
      return {
        render(width: number): string[] {
          if (cached?.width === width) return cached.lines;
          const lines = buildStartupHeaderLines(width, { logoLines });
          cached = { width, lines };
          return lines;
        },
        invalidate() {
          cached = undefined;
        },
      };
    });
  });
}
