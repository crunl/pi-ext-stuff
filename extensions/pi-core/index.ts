import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtension } from "./src/register.ts";

/**
 * pi-core extension entry. The cross-extension public surface lives in
 * standalone.ts (side-effect-free); it is re-exported here so existing
 * `../../pi-core/index.ts` imports keep working. New consumers should
 * import from standalone.ts directly to avoid loading this register
 * graph into their jiti instance.
 *
 * Internal helpers stay importable from src/tui/* for tests and in-tree use.
 */
export default function piCore(pi: ExtensionAPI): void {
  registerExtension(pi);
}

export * from "./standalone.ts";
