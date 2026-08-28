import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function collectTs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTs(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("structure invariants named by the cohesion review", () => {
  it("legacy safe-command whitelist is removed from production", async () => {
    const files = await collectTs("src");
    expect(files.some((file) => file.endsWith("permissions/safe-commands.ts"))).toBe(false);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (text.includes("permissions/safe-commands")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("RegisterExtensionOptions has no filtering-proxy factory seam", async () => {
    const source = await readFile("src/register.ts", "utf8");
    expect(source).toMatch(/export interface RegisterExtensionOptions/);
    expect(source).not.toMatch(/filteringProxyFactory/);
    expect(source).not.toMatch(/localProxyPorts/);
  });

  it("register owns no legacy orchestration modules", async () => {
    const source = await readFile("src/register.ts", "utf8");
    for (const module of [
      "auto-approval-ledger",
      "auto-policy",
      "enforced-tool",
      "grant-ledger",
      "sticky-permission-world",
    ]) {
      expect(source).not.toContain(module);
    }
  });

  it("uses one SRT-owned executor seam", async () => {
    const source = await readFile("src/sandbox/srt-enforcer.ts", "utf8");
    expect(source).toContain("@anthropic-ai/sandbox-runtime");
    expect(source).toContain("wrapWithSandboxArgv");
    expect(source).toMatch(/shell:\s*false/);
    expect(source).toMatch(/detached:\s*true/);
  });

  it("does not retain removed backend or filtering modules", async () => {
    const sandboxSource = await readFile("src/sandbox.ts", "utf8");
    const srtSource = await readFile("src/sandbox/srt-enforcer.ts", "utf8");
    for (const source of [sandboxSource, srtSource]) {
      expect(source).not.toContain("httpProxyPort");
      expect(source).not.toContain("socksProxyPort");
      expect(source).not.toContain("upstream_proxy");
    }
    expect(sandboxSource).not.toContain("feasible-allow");
    expect(srtSource).not.toContain("nono");
  });
});
