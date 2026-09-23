import { describe, expect, it } from "vitest";

import { isPathWithin } from "../src/permissions/paths.ts";

// The shared path-safety predicate is the single throat for isPathAllowed,
// delegation envelopes, writeRisk, and the Engine's lease coverage. Lock the
// prefix-sibling boundary so a string-prefix regression cannot slip in.
describe("isPathWithin", () => {
  it.each([
    { path: "/a/ab", root: "/a", expected: true },
    { path: "/a", root: "/a", expected: true },
    { path: "/a/", root: "/a", expected: true },
    { path: "/b", root: "/a", expected: false },
    { path: "/a/../b", root: "/a", expected: false },
    { path: "/a/abc", root: "/a/ab", expected: false },
    { path: "/a", root: "/a/ab", expected: false },
  ])("$path within $root → $expected", ({ path, root, expected }) => {
    expect(isPathWithin(path, root)).toBe(expected);
  });
});
