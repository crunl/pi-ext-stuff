import type { SelectListTheme } from "@earendil-works/pi-tui";

/** Identity theme stub shared by effort-command and selector-float tests. */
export const fakeTheme = {
  fg: (_c: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_c: string, text: string) => text,
} as any;

/** Identity SelectListTheme stub (avoids the pi theme singleton). */
export const fakeSelectListTheme: SelectListTheme = {
  selectedPrefix: (t: string) => t,
  selectedText: (t: string) => t,
  description: (t: string) => t,
  scrollInfo: (t: string) => t,
  noMatch: (t: string) => t,
} as SelectListTheme;
