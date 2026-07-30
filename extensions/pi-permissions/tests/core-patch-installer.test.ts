import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_AGENT_LOOP_PATH, installCorePatch } from "../scripts/install-core-patch.mjs";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-core-patch-"));
  const target = join(root, "pi-agent-core", "dist", "agent-loop.js");
  await mkdir(dirname(target), { recursive: true });
  const backup = `${CORE_AGENT_LOOP_PATH}.pi-permissions-0.82.1.orig`;
  const original = await access(backup).then(
    () => backup,
    () => CORE_AGENT_LOOP_PATH,
  );
  await copyFile(original, target);
  await writeFile(
    join(root, "pi-agent-core", "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-agent-core", version: "0.82.1" }),
  );
  return target;
}

describe("core patch installer", () => {
  it("installs the guarded abort gate and is idempotent", async () => {
    const target = await fixture();

    await expect(installCorePatch(target)).resolves.toBe("installed");
    const patched = await readFile(target, "utf8");
    expect(patched).toContain("pi-permissions.core.execution-abort-gate.v1");
    expect(patched).toContain("if (signal?.aborted)");
    await expect(installCorePatch(target)).resolves.toBe("already-installed");
  });

  it("rejects a source hash that is neither the supported original nor patched file", async () => {
    const target = await fixture();
    await writeFile(target, `${await readFile(target, "utf8")}\n// incompatible upgrade\n`);

    await expect(installCorePatch(target)).rejects.toThrow("unsupported core source hash");
  });

  it("rejects a different pi-agent-core version", async () => {
    const target = await fixture();
    await writeFile(
      join(dirname(dirname(target)), "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-agent-core", version: "0.83.0" }),
    );

    await expect(installCorePatch(target)).rejects.toThrow("supports pi-agent-core 0.82.1");
  });
});
