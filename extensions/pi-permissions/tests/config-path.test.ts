import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, fingerprintConfig, loadPermissionsConfig } from "../src/config.ts";
import {
  defaultPermissionsConfigPath,
  defaultProtectedWritePaths,
  legacyPermissionsConfigPath,
} from "../src/filesystem-policy.ts";

const tempDirs: string[] = [];

async function makeAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-permissions-config-path-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "extensions", "pi-permissions"), { recursive: true });
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("permissions config path resolution", () => {
  it("loads agentDir/permissions.json as the canonical source", async () => {
    const agentDir = await makeAgentDir();
    const path = defaultPermissionsConfigPath(agentDir);
    expect(path).toBe(join(agentDir, "permissions.json"));
    await writeJson(path, { sandbox: { network: { network_access: true } } });
    const loaded = await loadPermissionsConfig(agentDir);
    expect(loaded.source).toBe("new");
    expect(loaded.sourcePath).toBe(path);
    expect(loaded.config.sandbox.network.network_access).toBe(true);
    expect(fingerprintConfig(loaded.config)).toBe(fingerprintConfig(loaded.config));
  });

  it("falls back to the legacy extensions path when the new path is absent", async () => {
    const agentDir = await makeAgentDir();
    const legacy = legacyPermissionsConfigPath(agentDir);
    expect(legacy).toBe(join(agentDir, "extensions", "pi-permissions", "config.json"));
    await writeJson(legacy, {
      sandbox: { network: { network_access: true, trustedFakeIpRanges: ["198.18.0.0/15"] } },
    });
    const loaded = await loadPermissionsConfig(agentDir);
    expect(loaded.source).toBe("legacy");
    expect(loaded.sourcePath).toBe(legacy);
    expect(loaded.config.sandbox.network.network_access).toBe(true);
    expect(loaded.config.sandbox.network.trustedFakeIpRanges).toEqual(["198.18.0.0/15"]);
  });

  it("uses DEFAULT_CONFIG when neither path exists", async () => {
    const agentDir = await makeAgentDir();
    const loaded = await loadPermissionsConfig(agentDir);
    expect(loaded.source).toBe("default");
    expect(loaded.sourcePath).toBeUndefined();
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
  });

  it("prefers the new path when both exist", async () => {
    const agentDir = await makeAgentDir();
    const newPath = defaultPermissionsConfigPath(agentDir);
    const legacyPath = legacyPermissionsConfigPath(agentDir);
    await writeJson(newPath, { sandbox: { network: { network_access: true } } });
    await writeJson(legacyPath, { sandbox: { network: { network_access: false } } });
    const loaded = await loadPermissionsConfig(agentDir);
    expect(loaded.source).toBe("new");
    expect(loaded.sourcePath).toBe(newPath);
    expect(loaded.config.sandbox.network.network_access).toBe(true);
  });

  it("does not fall back when the new path exists but is invalid JSON", async () => {
    const agentDir = await makeAgentDir();
    const newPath = defaultPermissionsConfigPath(agentDir);
    const legacyPath = legacyPermissionsConfigPath(agentDir);
    await writeFile(newPath, "{invalid");
    await writeJson(legacyPath, { sandbox: { network: { network_access: true } } });
    await expect(loadPermissionsConfig(agentDir)).rejects.toThrow();
  });

  it("respects PI_CODING_AGENT_DIR for the default agent dir", async () => {
    const agentDir = await makeAgentDir();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      expect(defaultPermissionsConfigPath()).toBe(join(agentDir, "permissions.json"));
      expect(legacyPermissionsConfigPath()).toBe(
        join(agentDir, "extensions", "pi-permissions", "config.json"),
      );
      await writeJson(defaultPermissionsConfigPath(), {
        sandbox: { network: { network_access: true } },
      });
      const loaded = await loadPermissionsConfig(agentDir);
      expect(loaded.source).toBe("new");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("protects both the new and legacy config paths", async () => {
    const agentDir = await makeAgentDir();
    const cwd = "/workspace";
    const paths = defaultProtectedWritePaths(cwd, agentDir);
    expect(paths).toContain(join(agentDir, "permissions.json"));
    expect(paths).toContain(join(agentDir, "extensions", "pi-permissions", "config.json"));
    expect(paths).toContain(join(cwd, ".git"));
  });

  it("fingerprints are path-independent", async () => {
    const agentDir = await makeAgentDir();
    const overlay = { sandbox: { network: { network_access: true } } };
    await writeJson(defaultPermissionsConfigPath(agentDir), overlay);
    const fromNew = await loadPermissionsConfig(agentDir);
    await rm(defaultPermissionsConfigPath(agentDir), { force: true });
    await writeJson(legacyPermissionsConfigPath(agentDir), overlay);
    const fromLegacy = await loadPermissionsConfig(agentDir);
    expect(fromNew.source).toBe("new");
    expect(fromLegacy.source).toBe("legacy");
    expect(fingerprintConfig(fromNew.config)).toBe(fingerprintConfig(fromLegacy.config));
  });
});
