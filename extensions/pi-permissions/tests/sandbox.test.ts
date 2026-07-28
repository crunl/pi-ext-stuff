import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  createSandboxedBashOperations,
  createSandboxRuntimeConfig,
  detectLocalProxyPorts,
  OneShotNetworkGrants,
  withLocalProxy,
} from "../src/sandbox.ts";

describe("sandbox integration", () => {
  it("resolves workspace-relative paths before initializing the runtime", () => {
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, "/workspace/project");

    expect(runtime.filesystem.allowWrite).toContain("/workspace/project");
    expect(runtime.filesystem.denyRead).toContain("/workspace/project/.env");
    expect(runtime.filesystem.denyWrite).toContain("/workspace/project/*.key");
  });

  it("removes project write roots in read-only profile", () => {
    const runtime = createSandboxRuntimeConfig(
      { ...DEFAULT_CONFIG.sandbox, profile: "read-only" },
      "/workspace/project",
    );

    expect(runtime.filesystem.allowWrite).toEqual([]);
  });

  it("executes only the command returned by the sandbox manager", async () => {
    const manager = {
      initialize: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      wrapWithSandbox: vi.fn(async () => "printf sandboxed"),
    };
    const output: Buffer[] = [];

    const result = await createSandboxedBashOperations(manager).exec(
      "printf unsandboxed",
      join(process.cwd()),
      { onData: (data) => output.push(data) },
    );

    expect(manager.wrapWithSandbox).toHaveBeenCalledWith(
      "printf unsandboxed",
      undefined,
      undefined,
      undefined,
    );
    expect(Buffer.concat(output).toString()).toBe("sandboxed");
    expect(result.exitCode).toBe(0);
  });

  it("scopes network grants to the active command and handles overlap", () => {
    const grants = new OneShotNetworkGrants();
    const releaseFirst = grants.acquire(["example.com"]);
    const releaseSecond = grants.acquire(["EXAMPLE.com", "api.example.com"]);

    expect(grants.has("example.com")).toBe(true);
    expect(grants.has("api.example.com")).toBe(true);
    releaseFirst();
    expect(grants.has("example.com")).toBe(true);
    releaseSecond();
    expect(grants.has("example.com")).toBe(false);
    expect(grants.has("api.example.com")).toBe(false);
  });

  it("detects only loopback system proxies and applies them to one runtime", () => {
    const ports = detectLocalProxyPorts({
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5://localhost:7891",
    });
    expect(ports).toEqual({ http: 7890, socks: 7891 });
    expect(detectLocalProxyPorts({
      HTTPS_PROXY: "http://proxy.example.com:8080",
    })).toEqual({ http: undefined, socks: undefined });

    const runtime = withLocalProxy(
      createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, "/workspace/project"),
      ports,
    );
    expect(runtime.network.httpProxyPort).toBe(7890);
    expect(runtime.network.socksProxyPort).toBe(7891);
  });
});
