/** Identity theme stub for tests that invoke pi ui factories. */
export const fakeTheme = {
  fg: (_c: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_c: string, text: string) => text,
} as any;
