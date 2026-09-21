import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizePermissionAmendment } from "../src/permission-amendment.ts";

describe("normalizePermissionAmendment", () => {
  const cwd = "/workspace";
  const protectedWritePaths = [resolve(cwd, ".git"), "/opt/pi/extensions/pi-safety/config.json"];

  it("resolves relative write roots and lowercases public hosts", async () => {
    const result = await normalizePermissionAmendment(
      { hosts: ["API.Example.COM"], writeRoots: ["out"] },
      cwd,
      protectedWritePaths,
    );
    expect(result).toEqual({
      ok: true,
      amendment: {
        networkHosts: ["api.example.com"],
        writeRoots: [resolve(cwd, "out")],
      },
    });
  });

  it("rejects private or special-use hosts", async () => {
    const result = await normalizePermissionAmendment(
      { hosts: ["127.0.0.1"] },
      cwd,
      protectedWritePaths,
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects protected write roots", async () => {
    const result = await normalizePermissionAmendment(
      { writeRoots: [resolve(cwd, ".git")] },
      cwd,
      protectedWritePaths,
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("accepts the current workspace root as an explicit write root", async () => {
    const result = await normalizePermissionAmendment(
      { writeRoots: [homedir()] },
      cwd,
      protectedWritePaths,
    );
    expect(result).toEqual({
      ok: true,
      amendment: { networkHosts: [], writeRoots: [homedir()] },
    });
  });

  it("rejects glob write roots", async () => {
    const result = await normalizePermissionAmendment(
      { writeRoots: ["/tmp/*.log"] },
      cwd,
      protectedWritePaths,
    );
    expect(result).toMatchObject({ ok: false });
  });
});
