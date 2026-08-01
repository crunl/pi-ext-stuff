import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Enable all built-in tools by default.
 *
 * Pi ships with seven built-in tools but only activates four
 * (read, bash, edit, write) out of the box. This module ensures
 * grep, find, and ls are also active at session start, merging
 * with whatever tools are already active (extensions, etc.).
 */
export function registerBuiltInTools(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const builtinNames = pi
      .getAllTools()
      .filter((t) => t.sourceInfo.source === "builtin")
      .map((t) => t.name);

    const current = pi.getActiveTools();
    const merged = [...new Set([...current, ...builtinNames])];

    if (merged.length !== current.length) {
      pi.setActiveTools(merged);
    }
  });
}
