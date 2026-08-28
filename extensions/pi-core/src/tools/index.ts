import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Enable all built-in tools by default.
 *
 * Pi only activates a subset of its built-in tools out of the box, so at
 * session start this module merges every tool with a builtin source into
 * the active set, alongside whatever extensions already registered.
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
