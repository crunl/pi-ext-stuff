import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfigError } from "../src/config.ts";
import {
  DEFAULT_CONFIG,
  fingerprintConfig,
  loadPermissionsConfig,
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

function globalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", "pi-permissions", "config.json");
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

  it("ships a schema-valid complete example config", async () => {
    const contents = await readFile(join(import.meta.dirname, "..", "config.example.json"), "utf8");
    expect(() => validatePermissionsConfig(JSON.parse(contents))).not.toThrow();
  });

  it("accepts YOLO as a configured default mode", () => {
    expect(() => validatePermissionsConfig({ version: 1, defaultMode: "yolo" })).not.toThrow();
  });

  it("produces stable fingerprints", () => {
    expect(fingerprintConfig(DEFAULT_CONFIG)).toBe(
      fingerprintConfig(structuredClone(DEFAULT_CONFIG)),
    );
  });

  it("rejects unknown keys at every configuration object level", () => {
    expect(() => validatePermissionsConfig({ unknownRoot: true })).toThrow(/unknownRoot/);
    expect(() => validatePermissionsConfig({ sandbox: { unknownSandbox: true } })).toThrow(
      /sandbox\.unknownSandbox/,
    );
    expect(() =>
      validatePermissionsConfig({ sandbox: { filesystem: { unknownFilesystem: true } } }),
    ).toThrow(/sandbox\.filesystem\.unknownFilesystem/);
    expect(() =>
      validatePermissionsConfig({ sandbox: { network: { unknownNetwork: true } } }),
    ).toThrow(/sandbox\.network\.unknownNetwork/);
    expect(() =>
      validatePermissionsConfig({
        reviewer: { provider: "openai", model: "x", reasoningEffort: "low", unknownReviewer: true },
      }),
    ).toThrow(/reviewer\.unknownReviewer/);
    expect(() =>
      validatePermissionsConfig({ rules: [{ action: "deny", tool: "bash", unknownRule: true }] }),
    ).toThrow(/rules\[0\]\.unknownRule/);
  });

  it.each(["timeoutMs", "maxAttempts", "maxConsecutiveDenials"] as const)(
    "rejects removed reviewer policy field %s",
    (field) => {
      expect(() =>
        validatePermissionsConfig({
          reviewer: {
            provider: "openai-codex",
            model: "gpt-5.6-sol-fast",
            reasoningEffort: "medium",
            [field]: field === "timeoutMs" ? 60_000 : 3,
          },
        }),
      ).toThrow(new RegExp(`reviewer\\.${field}.*remove`, "i"));
    },
  );

  it("reports the exact path for invalid JSON", async () => {
    await withConfigRoots(async ({ agentDir }) => {
      const path = globalConfigPath(agentDir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "{");
      await expect(loadPermissionsConfig(agentDir)).rejects.toEqual(
        expect.objectContaining<Partial<ConfigError>>({
          name: "ConfigError",
          message: expect.stringContaining(path),
        }),
      );
    });
  });

  it("loads only plugin-local global configuration", async () => {
    await withConfigRoots(async ({ agentDir, cwd }) => {
      await writeJson(globalConfigPath(agentDir), {
        defaultMode: "auto",
        sandbox: { network: { allowedDomains: ["github.com"] } },
      });
      await writeJson(join(cwd, ".pi", "permissions.json"), {
        defaultMode: "default",
        sandbox: { network: { allowedDomains: ["attacker.invalid"] } },
      });
      const loaded = await loadPermissionsConfig(agentDir);

      expect(loaded.config.defaultMode).toBe("auto");
      expect(loaded.config.sandbox.network.allowedDomains).toEqual(["github.com"]);
    });
  });

  it("ignores the legacy agent-level permissions file", async () => {
    await withConfigRoots(async ({ agentDir }) => {
      await writeJson(join(agentDir, "permissions.json"), {
        sandbox: { profile: "read-only" },
      });
      const loaded = await loadPermissionsConfig(agentDir);
      expect(loaded.config.sandbox.profile).toBe("workspace-write");
    });
  });

  it("ignores malformed project permission configuration", async () => {
    await withConfigRoots(async ({ agentDir, cwd }) => {
      await writeJson(globalConfigPath(agentDir), { defaultMode: "default" });
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(join(cwd, ".pi", "permissions.json"), "{");

      await expect(loadPermissionsConfig(agentDir)).resolves.toMatchObject({
        config: { defaultMode: "default" },
      });
    });
  });

  it("allows global configuration to disable the sandbox", async () => {
    await withConfigRoots(async ({ agentDir }) => {
      await writeJson(globalConfigPath(agentDir), { sandbox: { enabled: false } });
      const loaded = await loadPermissionsConfig(agentDir);
      expect(loaded.config.sandbox.enabled).toBe(false);
    });
  });
});
