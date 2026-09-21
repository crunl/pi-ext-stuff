import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register `/exit` as a true alias for Pi's built-in `/quit`. */
export function registerExitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("exit", {
    description: "Quit Pi (alias for /quit)",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
