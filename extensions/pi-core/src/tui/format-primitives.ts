/** Strip ANSI SGR sequences (minimal — mirrors statusline's format.ts). */
export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC introduces every SGR sequence
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
