import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

/**
 * Pi has no public hook (verified through the 1.1.0 validation pin) for the
 * seams canonical-tool-fallback relies on: recreating the host SettingsManager
 * and identifying Pi's canonical bash/write/edit owners by their source marker.
 * Keep those deliberate runtime seams loud: a future Pi upgrade should fail
 * here instead of degrading later in an interactive session.
 *
 * The former autocomplete / Markdown renderToken / AssistantMessageComponent /
 * settings-selector pins guarded TUI prototype patches that have since been
 * removed in favour of stock host rendering; they are gone with the patches.
 */
describe("Pi 1.1.0 compatibility seams", () => {
  it("retains SettingsManager.create for the canonical bash fallback", () => {
    // canonical-tool-fallback recreates the host settings to feed Pi's
    // canonical shell configuration into createBashToolDefinition.
    const settings = SettingsManager.create(tmpdir(), tmpdir(), { projectTrusted: false });
    expect(typeof settings.drainErrors).toBe("function");
    expect(typeof settings.getShellPath).toBe("function");
    expect(typeof settings.getShellCommandPrefix).toBe("function");
  });

  it("retains the canonical builtin source marker format", () => {
    // canonical-tool-fallback identifies Pi's canonical bash/write/edit owners
    // by sourceInfo.path. Pi ≤0.88 inlined `<builtin:name>`; 0.99.0+ builds
    // `BUILTIN_PATH_PREFIX + name` (`builtin:name`). Pin the seam we rely on.
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const sessionSource = join(dirname(entry), "core", "agent-session.js");
    expect(existsSync(sessionSource)).toBe(true);
    const source = readFileSync(sessionSource, "utf8");
    expect(
      source.includes("BUILTIN_PATH_PREFIX") ||
        source.includes("<builtin:${") ||
        source.includes("builtin:${"),
    ).toBe(true);
  });
});
