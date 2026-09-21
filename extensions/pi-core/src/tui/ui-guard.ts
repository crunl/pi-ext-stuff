/** Shared guard for terminal-only affordances. In Pi 0.84, `hasUI` is true in
 * both TUI and RPC modes because RPC can answer dialogs; only `mode === "tui"`
 * supports raw terminal input, editor components, widgets, and working lines. */
export function isInteractiveTui(context: { hasUI: boolean; mode: string }): boolean {
  return context.hasUI && context.mode === "tui";
}
