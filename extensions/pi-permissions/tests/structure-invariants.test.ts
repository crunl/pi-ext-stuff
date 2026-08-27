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

function extractNamedFunction(source: string, name: string): string | undefined {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return undefined;
  const brace = source.indexOf("{", start);
  if (brace < 0) return undefined;
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
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

  it("duplicate shellQuote helpers are byte-identical", async () => {
    const sandbox = extractNamedFunction(await readFile("src/sandbox.ts", "utf8"), "shellQuote");
    const nono = extractNamedFunction(
      await readFile("src/sandbox/nono-enforcer.ts", "utf8"),
      "shellQuote",
    );
    expect(sandbox).toBeDefined();
    expect(nono).toBeDefined();
    expect(sandbox).toBe(nono);
  });

  it("does not retain removed proxy or git-config policy fields", async () => {
    const sandboxSource = await readFile("src/sandbox.ts", "utf8");
    const nonoSource = await readFile("src/sandbox/nono-enforcer.ts", "utf8");
    for (const source of [sandboxSource, nonoSource]) {
      expect(source).not.toContain("httpProxyPort");
      expect(source).not.toContain("socksProxyPort");
      expect(source).not.toContain("allowGitConfig");
      expect(source).not.toContain("askCallback");
    }
    expect(nonoSource).not.toContain("upstream_proxy");
  });
});
