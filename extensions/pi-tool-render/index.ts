import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtension } from "./src/register.ts";

/**
 * pi-tool-render extension entry. The cross-extension public surface lives in
 * standalone.ts (side-effect-free); it is re-exported here so consumers
 * importing index.ts keep working. New consumers should import from
 * standalone.ts directly to avoid loading this register graph into their
 * jiti instance.
 */
export default function piToolRender(pi: ExtensionAPI): void {
  registerExtension(pi);
}

export * from "./standalone.ts";
