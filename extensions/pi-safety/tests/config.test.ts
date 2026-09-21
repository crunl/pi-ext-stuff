import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfigError } from "../src/config.ts";
import {
  DEFAULT_CONFIG,
  effectiveNetworkAuthority,
  fingerprintConfig,
  loadSafetyConfig,
  validateSafetyConfig,
} from "../src/config.ts";

async function withConfigRoots(
  run: (paths: { root: string; cwd: string; agentDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-safety-config-"));
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
  return join(agentDir, "safety.json");
}

// Host-policy fixture only: fake SRT advertises macOS, never kernel support.
// Keep the exact original descriptor through all awaited work and cleanup.
function withDarwin<T extends unknown[]>(run: (...args: T) => Promise<void>) {
  return async (...args: T): Promise<void> => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "darwin" });
    try {
      await run(...args);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  };
}

describe("permissions config", () => {
  it.each(["linux", "win32"])(
    "rejects real non-macOS policy validation on simulated %s and restores positive fixtures",
    async (platform) => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...original, value: platform });
      const simulated = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        expect(() =>
          validateSafetyConfig({ sandbox: { network: { macosTls: "system" } } }),
        ).toThrow(/macOS/);
        await withDarwin(async () => {
          expect(
            validateSafetyConfig({ sandbox: { network: { macosTls: "system" } } }).sandbox.network
              .macosTls,
          ).toBe("system");
        })();
        expect(Object.getOwnPropertyDescriptor(process, "platform")).toEqual(simulated);
        await expect(
          withDarwin(async () => {
            throw new Error("fixture failure");
          })(),
        ).rejects.toThrow("fixture failure");
        expect(Object.getOwnPropertyDescriptor(process, "platform")).toEqual(simulated);
      } finally {
        Object.defineProperty(process, "platform", original);
      }
    },
  );

  it("accepts explicit proxy opt-in without changing legacy defaults", () => {
    expect(validateSafetyConfig({}).sandbox.network.access).toBeUndefined();
    const input = { sandbox: { network: { access: { kind: "explicit", transport: "proxy" } } } };
    const config = validateSafetyConfig(input);
    expect(config.sandbox.network.access).toEqual({ kind: "explicit", transport: "proxy" });
    expect(fingerprintConfig(config)).not.toBe(fingerprintConfig(DEFAULT_CONFIG));
    input.sandbox.network.access.kind = "inline-proxy";
    expect(config.sandbox.network.access?.kind).toBe("explicit");
  });

  it.each([
    null,
    undefined,
    {},
    { kind: "direct" },
    { kind: "explicit" },
    { kind: "inline-proxy", transport: "proxy" },
    { kind: "explicit", transport: "proxy", unknown: true },
    Object.assign(Object.create({ kind: "inline-proxy" }), { unknown: true }),
    Object.assign(Object.create({ kind: "explicit" }), { transport: "proxy", unknown: true }),
  ])("rejects unsupported network access rather than downgrading: %j", (access) => {
    expect(() => validateSafetyConfig({ sandbox: { network: { access } } })).toThrow(/access/);
  });

  it("requires private eligibility for direct unless network_access provides it", () => {
    expect(() =>
      validateSafetyConfig({
        sandbox: {
          network: { network_access: false, access: { kind: "explicit", transport: "direct" } },
        },
      }),
    ).toThrow(/private\/special/);
    expect(() =>
      validateSafetyConfig({
        sandbox: { network: { access: { kind: "explicit", transport: "direct" } } },
      }),
    ).toThrow(/private\/special/);
    const input = {
      sandbox: {
        network: {
          access: { kind: "explicit", transport: "direct" },
          network_access: true,
          macosTls: "strict",
        },
      },
    };
    const config = validateSafetyConfig(input);
    expect(config.sandbox.network).toMatchObject({
      network_access: true,
    });
    const tighter = {
      sandbox: {
        network: {
          access: { kind: "explicit", transport: "direct" } as const,
          network_access: false,
          allowPrivateTargets: true,
          macosTls: "strict" as const,
        },
      },
    };
    expect(config.sandbox.network.network_access).toBe(true);
    expect(fingerprintConfig(config)).not.toBe(fingerprintConfig(validateSafetyConfig(tighter)));
  });

  it.each([
    { allowedDomains: ["api.example.com"] },
    { deniedDomains: ["blocked.example.com"] },
    { macosTls: "system" },
    { allowLocalBinding: true, network_access: false },
  ])(
    "rejects direct policy conflicts before activation: %j",
    withDarwin(async (conflict) => {
      expect(() =>
        validateSafetyConfig({
          sandbox: {
            network: {
              access: { kind: "explicit", transport: "direct" },
              allowPrivateTargets: true,
              ...conflict,
            },
          },
        }),
      ).toThrow();
    }),
  );

  it.each([{ network_access: true }, { allowPrivateTargets: true }, { macosTls: "system" }])(
    "fingerprints and clones each independent network authority/profile dimension: %j",
    withDarwin(async (network) => {
      const input = { sandbox: { network } };
      const config = validateSafetyConfig(input);
      expect(fingerprintConfig(config)).not.toBe(fingerprintConfig(DEFAULT_CONFIG));
      expect(fingerprintConfig(config)).toBe(fingerprintConfig(structuredClone(config)));
      Object.assign(input.sandbox.network, {
        network_access: false,
        allowPrivateTargets: false,
        macosTls: "strict",
      });
      expect(fingerprintConfig(config)).not.toBe(fingerprintConfig(validateSafetyConfig(input)));
    }),
  );

  it("supports broad baseline direct binding only as an explicit separate high-privilege choice", () => {
    const config = validateSafetyConfig({
      sandbox: {
        network: {
          access: { kind: "explicit", transport: "direct" },
          network_access: true,
          allowLocalBinding: true,
        },
      },
    });
    expect(config.sandbox.network.allowPrivateTargets).toBeUndefined();
    expect(config.sandbox.network.allowLocalBinding).toBe(true);
  });

  it("accepts absolute allowUnixSockets and dangerouslyAllowAllUnixSockets", () => {
    const config = validateSafetyConfig({
      sandbox: {
        network: {
          allowUnixSockets: ["/Users/x1a2h1/.orbstack/run/docker.sock"],
          dangerouslyAllowAllUnixSockets: false,
        },
      },
    });
    expect(config.sandbox.network.allowUnixSockets).toEqual([
      "/Users/x1a2h1/.orbstack/run/docker.sock",
    ]);
    expect(config.sandbox.network.dangerouslyAllowAllUnixSockets).toBe(false);
  });

  it("fingerprints independently when unix socket axes change", () => {
    const withSocket = validateSafetyConfig({
      sandbox: {
        network: { allowUnixSockets: ["/Users/x1a2h1/.orbstack/run/docker.sock"] },
      },
    });
    const withDanger = validateSafetyConfig({
      sandbox: { network: { dangerouslyAllowAllUnixSockets: true } },
    });
    const base = fingerprintConfig(DEFAULT_CONFIG);
    expect(fingerprintConfig(withSocket)).not.toBe(base);
    expect(fingerprintConfig(withDanger)).not.toBe(base);
    expect(fingerprintConfig(withSocket)).not.toBe(fingerprintConfig(withDanger));
  });

  it("keeps unix socket fields absent on DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.sandbox.network.allowUnixSockets).toBeUndefined();
    expect(DEFAULT_CONFIG.sandbox.network.dangerouslyAllowAllUnixSockets).toBeUndefined();
  });

  it.each([
    { allowUnixSockets: ["relative/docker.sock"] },
    { allowUnixSockets: ["~/orbstack/run/docker.sock"] },
    { allowUnixSockets: ["/Users/*/docker.sock"] },
    { allowUnixSockets: ["/"] },
    { allowUnixSockets: ["/Users/x1a2h1/.orbstack/run/"] },
    { allowUnixSockets: ["/Users/x1a2h1/.."] },
  ])("rejects non-absolute, glob, or directory unix socket paths: %j", (network) => {
    expect(() => validateSafetyConfig({ sandbox: { network } })).toThrow(/allowUnixSockets/);
  });

  it("rejects unknown unix socket-shaped network keys", () => {
    expect(() =>
      validateSafetyConfig({
        sandbox: { network: { unixSockets: { "/tmp/x.sock": "allow" } } },
      }),
    ).toThrow(/unixSockets/);
  });

  it.each([
    { deniedDomains: ["*"] },
    { deniedDomains: ["blocked.example.com"] },
    { allowLocalBinding: true },
    { allowedDomains: ["localhost"] },
    { allowedDomains: ["localhost:443"] },
    { allowedDomains: ["[::1]"] },
    { allowedDomains: ["[::1]:443"] },
  ])(
    "rejects system helper policy conflicts: %j",
    withDarwin(async (conflict) => {
      expect(() =>
        validateSafetyConfig({ sandbox: { network: { macosTls: "system", ...conflict } } }),
      ).toThrow(/System TLS/);
    }),
  );

  it("rejects the removed sandbox.network.enabled field with a migration error", () => {
    expect(() => validateSafetyConfig({ sandbox: { network: { enabled: true } } })).toThrow(
      /network_access/,
    );
    expect(() => validateSafetyConfig({ sandbox: { network: { enabled: false } } })).toThrow(
      /was removed/,
    );
  });

  it("rejects network_access:true with system TLS unless local binding is tightened", () => {
    expect(() =>
      validateSafetyConfig({
        sandbox: { network: { network_access: true, macosTls: "system" } },
      }),
    ).toThrow(/System TLS/);
    expect(() =>
      validateSafetyConfig({
        sandbox: {
          network: { network_access: true, macosTls: "system", allowLocalBinding: false },
        },
      }),
    ).not.toThrow();
  });

  describe("effectiveNetworkAuthority", () => {
    it.each([
      [{}, { wholeNetwork: false, privateTargets: false, localBinding: false }],
      [
        { network_access: false },
        { wholeNetwork: false, privateTargets: false, localBinding: false },
      ],
      [{ network_access: true }, { wholeNetwork: true, privateTargets: true, localBinding: true }],
      [
        { network_access: true, allowPrivateTargets: false },
        { wholeNetwork: true, privateTargets: false, localBinding: true },
      ],
      [
        { network_access: true, allowLocalBinding: false },
        { wholeNetwork: true, privateTargets: true, localBinding: false },
      ],
      [
        { network_access: true, allowPrivateTargets: false, allowLocalBinding: false },
        { wholeNetwork: true, privateTargets: false, localBinding: false },
      ],
      [
        { allowPrivateTargets: true },
        { wholeNetwork: false, privateTargets: true, localBinding: false },
      ],
    ])("derives %j → %j", (input, expected) => {
      expect(effectiveNetworkAuthority(input)).toEqual(expected);
    });
  });

  it.each([
    { enabled: "true" },
    { enabled: null },
    { enabled: undefined },
    { allowPrivateTargets: "true" },
    { allowPrivateTargets: null },
    { macosTls: false },
    { macosTls: null },
    { macosTls: "automatic" },
  ])("rejects malformed network authority/startup fields: %j", (network) => {
    expect(() => validateSafetyConfig({ sandbox: { network } })).toThrow();
  });

  it("rejects explicit local socket bypass authority", () => {
    expect(() =>
      validateSafetyConfig({
        sandbox: {
          network: {
            access: { kind: "explicit", transport: "proxy" },
            allowLocalBinding: true,
          },
        },
      }),
    ).toThrow(/allowLocalBinding/);
  });

  it("defaults to a sandboxed Auto session", () => {
    expect(DEFAULT_CONFIG.sandbox.enabled).toBe(true);
    expect(DEFAULT_CONFIG.sandbox.filesystem.allowWrite).toEqual([".", "/tmp"]);
    expect(DEFAULT_CONFIG.sandbox.network.allowedDomains).toEqual([]);
    expect(DEFAULT_CONFIG.sandbox.network.deniedDomains).toEqual([]);
  });

  it("matches Codex workspace-write without extra sensitive-file denials", () => {
    expect(DEFAULT_CONFIG.sandbox.filesystem.denyRead).toEqual([]);
    expect(DEFAULT_CONFIG.sandbox.filesystem.denyWrite).toEqual([]);
  });

  it("ships a schema-valid complete example config", async () => {
    const contents = await readFile(join(import.meta.dirname, "..", "config.example.json"), "utf8");
    expect(() => validateSafetyConfig(JSON.parse(contents))).not.toThrow();
  });

  it("rejects removed human-prompt keys instead of silently ignoring them", () => {
    expect(() =>
      validateSafetyConfig({
        version: 1,
        defaultMode: "yolo",
        approvalMode: "never",
        granularApproval: { rules: false },
      }),
    ).toThrow(/defaultMode is not allowed/);
  });

  it("produces stable fingerprints", () => {
    expect(fingerprintConfig(DEFAULT_CONFIG)).toBe(
      fingerprintConfig(structuredClone(DEFAULT_CONFIG)),
    );
  });

  it("rejects unknown keys at every configuration object level", () => {
    expect(() => validateSafetyConfig({ unknownRoot: true })).toThrow(/unknownRoot/);
    expect(() => validateSafetyConfig({ sandbox: { unknownSandbox: true } })).toThrow(
      /sandbox\.unknownSandbox/,
    );
    expect(() =>
      validateSafetyConfig({ sandbox: { filesystem: { unknownFilesystem: true } } }),
    ).toThrow(/sandbox\.filesystem\.unknownFilesystem/);
    expect(() => validateSafetyConfig({ sandbox: { network: { unknownNetwork: true } } })).toThrow(
      /sandbox\.network\.unknownNetwork/,
    );
    expect(() =>
      validateSafetyConfig({
        reviewer: { provider: "openai", model: "x", reasoningEffort: "low", unknownReviewer: true },
      }),
    ).toThrow(/reviewer\.unknownReviewer/);
    expect(() =>
      validateSafetyConfig({ rules: [{ action: "deny", tool: "bash", unknownRule: true }] }),
    ).toThrow(/rules\[0\]\.unknownRule/);
  });

  it("rejects malformed SRT network patterns and fake-IP ranges while loading", () => {
    expect(() =>
      validateSafetyConfig({
        sandbox: { network: { trustedFakeIpRanges: ["198.18.0.0/99"] } },
      }),
    ).toThrow(/trustedFakeIpRanges/);
    expect(() =>
      validateSafetyConfig({
        sandbox: { network: { trustedFakeIpRanges: ["198.18.0.0 /15"] } },
      }),
    ).toThrow(/trustedFakeIpRanges/);
    expect(() =>
      validateSafetyConfig({ sandbox: { network: { deniedDomains: ["::1"] } } }),
    ).toThrow(/deniedDomains/);
    expect(() => validateSafetyConfig({ sandbox: { network: { allowedDomains: ["*"] } } })).toThrow(
      /allowedDomains/,
    );
    expect(() =>
      validateSafetyConfig({ sandbox: { network: { allowedDomains: ["*.com"] } } }),
    ).toThrow(/allowedDomains/);
    expect(
      validateSafetyConfig({
        sandbox: {
          network: {
            allowedDomains: ["*.example.com:443"],
            deniedDomains: ["[::1]:443", "*:22"],
          },
        },
      }).sandbox.network,
    ).toMatchObject({
      allowedDomains: ["*.example.com:443"],
      deniedDomains: ["[::1]:443", "*:22"],
    });
  });

  it.each(["timeoutMs", "maxAttempts", "maxConsecutiveDenials"] as const)(
    "rejects removed reviewer policy field %s",
    (field) => {
      expect(() =>
        validateSafetyConfig({
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
      await expect(loadSafetyConfig(agentDir)).rejects.toEqual(
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
        sandbox: { network: { allowedDomains: ["github.com"] } },
      });
      await writeJson(join(cwd, ".pi", "permissions.json"), {
        sandbox: { network: { allowedDomains: ["attacker.invalid"] } },
      });
      const loaded = await loadSafetyConfig(agentDir);

      expect(loaded.config.sandbox.network.allowedDomains).toEqual(["github.com"]);
    });
  });

  it("loads the agent-level safety.json as the canonical source", async () => {
    await withConfigRoots(async ({ agentDir }) => {
      await writeJson(join(agentDir, "safety.json"), {
        sandbox: { profile: "read-only" },
      });
      const loaded = await loadSafetyConfig(agentDir);
      expect(loaded.source).toBe("new");
      expect(loaded.config.sandbox.profile).toBe("read-only");
    });
  });

  it("ignores malformed project permission configuration", async () => {
    await withConfigRoots(async ({ agentDir, cwd }) => {
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(join(cwd, ".pi", "permissions.json"), "{");

      const loaded = await loadSafetyConfig(agentDir);
      expect(loaded.config).toEqual(DEFAULT_CONFIG);
    });
  });

  it("allows global configuration to disable the sandbox", async () => {
    await withConfigRoots(async ({ agentDir }) => {
      await writeJson(globalConfigPath(agentDir), { sandbox: { enabled: false } });
      const loaded = await loadSafetyConfig(agentDir);
      expect(loaded.config.sandbox.enabled).toBe(false);
    });
  });
});
