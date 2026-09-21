import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, fingerprintConfig, loadSafetyConfig } from "../src/config.ts";
import { defaultProtectedWritePaths, defaultSafetyConfigPath } from "../src/filesystem-policy.ts";

const tempDirs: string[] = [];

async function makeAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-safety-config-path-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "extensions"), { recursive: true });
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("safety config path resolution", () => {
  it("loads agentDir/safety.json as the canonical source", async () => {
    const agentDir = await makeAgentDir();
    const path = defaultSafetyConfigPath(agentDir);
    expect(path).toBe(join(agentDir, "safety.json"));
    await writeJson(path, { sandbox: { network: { network_access: true } } });
    const loaded = await loadSafetyConfig(agentDir);
    expect(loaded.source).toBe("new");
    expect(loaded.sourcePath).toBe(path);
    expect(loaded.config.sandbox.network.network_access).toBe(true);
    expect(fingerprintConfig(loaded.config)).toBe(fingerprintConfig(loaded.config));
  });

  it("uses DEFAULT_CONFIG when no config file exists", async () => {
    const agentDir = await makeAgentDir();
    const loaded = await loadSafetyConfig(agentDir);
    expect(loaded.source).toBe("default");
    expect(loaded.sourcePath).toBeUndefined();
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
  });

  it("rejects invalid JSON rather than silently falling back", async () => {
    const agentDir = await makeAgentDir();
    const newPath = defaultSafetyConfigPath(agentDir);
    await writeFile(newPath, "{invalid");
    await expect(loadSafetyConfig(agentDir)).rejects.toThrow();
  });

  it("respects PI_CODING_AGENT_DIR for the default agent dir", async () => {
    const agentDir = await makeAgentDir();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      expect(defaultSafetyConfigPath()).toBe(join(agentDir, "safety.json"));
      await writeJson(defaultSafetyConfigPath(), {
        sandbox: { network: { network_access: true } },
      });
      const loaded = await loadSafetyConfig(agentDir);
      expect(loaded.source).toBe("new");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("protects the config path and git metadata roots", async () => {
    const agentDir = await makeAgentDir();
    const cwd = "/workspace";
    const paths = defaultProtectedWritePaths(cwd, agentDir);
    expect(paths).toContain(join(agentDir, "safety.json"));
    expect(paths).toContain(join(cwd, ".git"));
  });

  it("fingerprints are stable for identical content", async () => {
    const agentDir = await makeAgentDir();
    const overlay = { sandbox: { network: { network_access: true } } };
    await writeJson(defaultSafetyConfigPath(agentDir), overlay);
    const first = await loadSafetyConfig(agentDir);
    const second = await loadSafetyConfig(agentDir);
    expect(first.source).toBe("new");
    expect(fingerprintConfig(first.config)).toBe(fingerprintConfig(second.config));
  });
});
