import { SandboxManager, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { describe, expect, it } from "vitest";

/**
 * Product contract after Native Proxy + Lease Spawn Gate:
 * installed SRT is pristine (no network.mode / getNetworkModeCapabilities).
 * Network authority is Engine lease + connect-guard on native parentProxy.
 */
describe("pristine sandbox-runtime (no network.mode patch)", () => {
  it("does not expose getNetworkModeCapabilities", () => {
    const manager = SandboxManager as unknown as Record<string, unknown>;
    expect(manager.getNetworkModeCapabilities).toBeUndefined();
  });

  it("strips unknown network.mode from the public config schema", () => {
    const parsed = SandboxRuntimeConfigSchema.parse({
      filesystem: { allowWrite: ["."], denyRead: [], denyWrite: [] },
      network: {
        allowedDomains: [],
        deniedDomains: [],
        mode: "restricted",
      },
    });
    const network = (parsed as { network?: Record<string, unknown> }).network;
    expect(network).toBeDefined();
    expect(network).not.toHaveProperty("mode");
    expect(network?.mode).toBeUndefined();
  });
});
