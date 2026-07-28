import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_CONFIG,
  fingerprintConfig,
  loadPermissionsConfig,
  mergePermissionsConfig,
  validatePermissionsConfig,
} from "../src/config.ts";

async function withConfigRoots(
  run: (paths: { root: string; cwd: string; agentDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-config-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  try {
    await run({ root, cwd, agentDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

describe("permissions config", () => {
  it("defaults to sandboxed default mode", () => {
    expect(DEFAULT_CONFIG.defaultMode).toBe("default");
    expect(DEFAULT_CONFIG.sandbox.enabled).toBe(true);
    expect(DEFAULT_CONFIG.sandbox.filesystem.allowWrite).toEqual([".", "/tmp"]);
    expect(DEFAULT_CONFIG.sandbox.network.allowedDomains).toEqual([]);
  });

  it("denies sensitive workspace files for reads and writes by default", () => {
    expect(DEFAULT_CONFIG.sandbox.filesystem.denyRead).toEqual(
      expect.arrayContaining([".env", ".env.*", "*.pem", "*.key"]),
    );
    expect(DEFAULT_CONFIG.sandbox.filesystem.denyWrite).toEqual(
      expect.arrayContaining([".env", ".env.*", "*.pem", "*.key"]),
    );
  });

  it("does not let a project allow override a global deny", () => {
    const merged = mergePermissionsConfig(
      { ...DEFAULT_CONFIG, rules: [{ action: "deny", tool: "bash", pattern: "git push*" }] },
      { rules: [{ action: "allow", tool: "bash", pattern: "git push origin feature" }] },
    );
    expect(merged.rules[0]?.action).toBe("deny");
  });

  it("rejects an unknown mode", () => {
    expect(() => validatePermissionsConfig({ version: 1, defaultMode: "yolo" })).toThrow(/defaultMode/);
  });

  it("produces stable fingerprints", () => {
    expect(fingerprintConfig(DEFAULT_CONFIG)).toBe(fingerprintConfig(structuredClone(DEFAULT_CONFIG)));
  });

  it("rejects unknown keys at every configuration object level", () => {
    expect(() => validatePermissionsConfig({ unknownRoot: true })).toThrow(/unknownRoot/);
    expect(() => validatePermissionsConfig({ sandbox: { unknownSandbox: true } })).toThrow(/sandbox\.unknownSandbox/);
    expect(() => validatePermissionsConfig({ sandbox: { filesystem: { unknownFilesystem: true } } })).toThrow(/sandbox\.filesystem\.unknownFilesystem/);
    expect(() => validatePermissionsConfig({ sandbox: { network: { unknownNetwork: true } } })).toThrow(/sandbox\.network\.unknownNetwork/);
    expect(() => validatePermissionsConfig({ reviewer: { provider: "openai", model: "x", reasoningEffort: "low", timeoutMs: 1, maxConsecutiveDenials: 1, unknownReviewer: true } })).toThrow(/reviewer\.unknownReviewer/);
    expect(() => validatePermissionsConfig({ rules: [{ action: "deny", tool: "bash", unknownRule: true }] })).toThrow(/rules\[0\]\.unknownRule/);
  });

  it("reports the exact path for invalid JSON", async () => {
    await withConfigRoots(async ({ agentDir, cwd }) => {
      const path = join(agentDir, "permissions.json");
      await writeFile(path, "{");
      await expect(loadPermissionsConfig(cwd, agentDir, false)).rejects.toEqual(
        expect.objectContaining<Partial<ConfigError>>({ name: "ConfigError", message: expect.stringContaining(path) }),
      );
    });
  });

  it("applies trusted project deny rules without applying requested write or network expansions", async () => {
    await withConfigRoots(async ({ agentDir, cwd }) => {
      await writeJson(join(agentDir, "permissions.json"), {
        sandbox: { network: { allowedDomains: ["github.com"] } },
      });
      await writeJson(join(cwd, ".pi", "permissions.json"), {
        sandbox: {
          filesystem: { allowWrite: [".", "generated"], denyWrite: ["secrets/*"] },
          network: { allowedDomains: ["github.com", "api.example.test"], deniedDomains: ["internal.example.test"] },
        },
        rules: [{ action: "deny", tool: "bash", pattern: "curl *" }],
      });
      const loaded = await loadPermissionsConfig(cwd, agentDir, true);
      expect(loaded.config.sandbox.filesystem.allowWrite).toEqual(["."]);
      expect(loaded.config.sandbox.filesystem.denyWrite).toContain("secrets/*");
      expect(loaded.config.sandbox.network.allowedDomains).toEqual(["github.com"]);
      expect(loaded.config.sandbox.network.deniedDomains).toContain("internal.example.test");
      expect(loaded.config.rules).toContainEqual({ action: "deny", tool: "bash", pattern: "curl *" });
      expect(loaded.projectExpansions).toEqual([
        { kind: "write-root", value: "generated" },
        { kind: "network-domain", value: "api.example.test" },
      ]);
    });
  });

  it("does not let a project elevate a read-only global sandbox profile", async () => {
    await withConfigRoots(async ({ agentDir, cwd }) => {
      await writeJson(join(agentDir, "permissions.json"), { sandbox: { profile: "read-only" } });
      await writeJson(join(cwd, ".pi", "permissions.json"), { sandbox: { profile: "workspace-write" } });
      const loaded = await loadPermissionsConfig(cwd, agentDir, true);
      expect(loaded.config.sandbox.profile).toBe("read-only");
    });
  });

  it("allows global configuration to disable the sandbox", async () => {
    await withConfigRoots(async ({ agentDir, cwd }) => {
      await writeJson(join(agentDir, "permissions.json"), { sandbox: { enabled: false } });
      const loaded = await loadPermissionsConfig(cwd, agentDir, false);
      expect(loaded.globalConfig.sandbox.enabled).toBe(false);
      expect(loaded.config.sandbox.enabled).toBe(false);
    });
  });

  it("does not let a project expand an empty global network allowlist", async () => {
    await withConfigRoots(async ({ agentDir, cwd }) => {
      await writeJson(join(agentDir, "permissions.json"), { sandbox: { network: { allowedDomains: [] } } });
      await writeJson(join(cwd, ".pi", "permissions.json"), { sandbox: { network: { allowedDomains: ["api.example.test"] } } });
      const loaded = await loadPermissionsConfig(cwd, agentDir, true);
      expect(loaded.config.sandbox.network.allowedDomains).toEqual([]);
      expect(loaded.projectExpansions).toEqual([
        { kind: "network-domain", value: "api.example.test" },
      ]);
    });
  });
});
