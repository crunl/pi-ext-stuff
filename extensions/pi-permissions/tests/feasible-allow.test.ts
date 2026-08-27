import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterFeasibleAllowPaths,
  isFeasibleAllowPath,
  nonoProtectedStateRoot,
} from "../src/sandbox/feasible-allow.ts";

describe("isFeasibleAllowPath", () => {
  const home = "/Users/me";
  const state = resolve(home, ".local", "state", "nono");

  it("rejects home and other ancestors of the protected nono state root", () => {
    expect(isFeasibleAllowPath(home, state)).toBe(false);
    expect(isFeasibleAllowPath("/Users", state)).toBe(false);
    expect(isFeasibleAllowPath("/", state)).toBe(false);
    expect(isFeasibleAllowPath(state, state)).toBe(false);
  });

  it("keeps project trees, /tmp, and files that do not cover the state root", () => {
    expect(isFeasibleAllowPath(resolve(home, ".pi", "agent"), state)).toBe(true);
    expect(isFeasibleAllowPath(resolve(home, ".pi", "agent", "models.json"), state)).toBe(true);
    expect(isFeasibleAllowPath("/tmp", state)).toBe(true);
    expect(isFeasibleAllowPath("/private/tmp", state)).toBe(true);
  });

  it("rejects paths inside the protected state root", () => {
    expect(isFeasibleAllowPath(resolve(state, "sessions", "x"), state)).toBe(false);
  });
});

describe("filterFeasibleAllowPaths", () => {
  it("drops $HOME from a default allowWrite list and keeps /tmp", () => {
    const home = homedir();
    const state = nonoProtectedStateRoot(home);
    expect(filterFeasibleAllowPaths([home, "/tmp", "/private/tmp"], state)).toEqual([
      "/tmp",
      "/private/tmp",
    ]);
  });

  it("keeps a file grant when its parent directory is infeasible", () => {
    const home = "/Users/me";
    const state = resolve(home, ".local", "state", "nono");
    const file = resolve(home, "notes.txt");
    expect(filterFeasibleAllowPaths([file, home], state)).toEqual([file]);
  });
});
