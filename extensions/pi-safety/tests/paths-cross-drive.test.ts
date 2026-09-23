import { describe, expect, it, vi } from "vitest";

// `isPathWithin` decides containment from `path.relative`, and on Windows that
// call returns an absolute path when the two paths share no root — different
// drives (`C:\a` vs `D:\b`). Such a remainder is not a descendant, so it must
// fail closed instead of reading as "inside". Simulate win32 path semantics so
// the cross-drive branch is exercised on every platform: the same remainders
// stay relative (and read identically) for paths on one drive.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    isAbsolute: actual.win32.isAbsolute,
    relative: actual.win32.relative,
    sep: actual.win32.sep,
  };
});

import { isPathWithin } from "../src/permissions/paths.ts";

describe("isPathWithin under win32 path semantics", () => {
  it("fails closed when the two paths share no root (different drives)", () => {
    expect(isPathWithin("D:\\b", "C:\\a")).toBe(false);
    expect(isPathWithin("D:\\a\\b", "C:\\a")).toBe(false);
  });

  it("still contains descendants and rejects siblings on one drive", () => {
    expect(isPathWithin("C:\\a\\b", "C:\\a")).toBe(true);
    expect(isPathWithin("C:\\a", "C:\\a")).toBe(true);
    expect(isPathWithin("C:\\ab", "C:\\a")).toBe(false);
  });
});
