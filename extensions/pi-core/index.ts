import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtension } from "./src/register.ts";

/**
 * pi-core extension entry. Registers editor chrome, the working token-rate
 * indicator, and the /effort and /exit commands.
 */
export default function piCore(pi: ExtensionAPI): void {
  registerExtension(pi);
}
