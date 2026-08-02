/** Shared guard: only the interactive TUI supports widgets, working lines,
 * and other extension UI affordances. RPC/print/json modes must not be
 * touched (their UI methods are no-ops or unavailable). */
export function isInteractiveTui(context: { hasUI: boolean; mode: string }): boolean {
  return context.hasUI && context.mode === "tui";
}
