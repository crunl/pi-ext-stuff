import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  DEFAULT_BASH_TIMEOUT_SECONDS,
  MAX_BASH_TIMEOUT_SECONDS,
  nextMode,
  normalizeEscalatedBashTimeout,
  requiresNetworkQuiescence,
  requiresSandbox,
  stableSessionId,
} from "../src/register-support.ts";
import type { SandboxPolicy } from "../src/sandbox-policy.ts";

describe("normalizeEscalatedBashTimeout", () => {
  it("defaults an unset timeout to the escalated host budget", () => {
    expect(normalizeEscalatedBashTimeout(undefined)).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_BASH_TIMEOUT_SECONDS + 1])(
    "rejects invalid timeout %s",
    (timeout) => {
      expect(() => normalizeEscalatedBashTimeout(timeout)).toThrow(/Invalid timeout/);
    },
  );

  it("passes through a valid finite timeout", () => {
    expect(normalizeEscalatedBashTimeout(30)).toBe(30);
    expect(normalizeEscalatedBashTimeout(MAX_BASH_TIMEOUT_SECONDS)).toBe(MAX_BASH_TIMEOUT_SECONDS);
  });
});

describe("mode helpers", () => {
  it("cycles auto <-> yolo", () => {
    expect(nextMode("auto")).toBe("yolo");
    expect(nextMode("yolo")).toBe("auto");
  });

  it("requires a sandbox only outside yolo when sandbox is enabled", () => {
    expect(requiresSandbox("auto", DEFAULT_CONFIG)).toBe(true);
    expect(requiresSandbox("yolo", DEFAULT_CONFIG)).toBe(false);
    expect(
      requiresSandbox("auto", {
        ...DEFAULT_CONFIG,
        sandbox: { ...DEFAULT_CONFIG.sandbox, enabled: false },
      }),
    ).toBe(false);
  });
});

describe("requiresNetworkQuiescence", () => {
  const baseNetwork = (): SandboxPolicy["network"] => ({
    allowedDomains: [],
    deniedDomains: [],
  });

  it("is false without a network policy", () => {
    expect(requiresNetworkQuiescence(undefined)).toBe(false);
  });

  it("is false for a plain proxied policy", () => {
    expect(requiresNetworkQuiescence(baseNetwork())).toBe(false);
  });

  it("is true for explicit direct transport", () => {
    expect(
      requiresNetworkQuiescence({
        ...baseNetwork(),
        access: { kind: "explicit", transport: "direct" },
      }),
    ).toBe(true);
  });

  it("is true for system TLS (helper-mediated egress)", () => {
    expect(requiresNetworkQuiescence({ ...baseNetwork(), macosTls: "system" })).toBe(true);
  });

  it("is true when local binding is allowed", () => {
    expect(requiresNetworkQuiescence({ ...baseNetwork(), allowLocalBinding: true })).toBe(true);
  });

  it("inherits local binding from whole-network access", () => {
    expect(requiresNetworkQuiescence({ ...baseNetwork(), network_access: true })).toBe(true);
  });
});

describe("stableSessionId", () => {
  const ctxWith = (sessionManager: unknown): Pick<ExtensionContext, "sessionManager"> =>
    ({ sessionManager }) as Pick<ExtensionContext, "sessionManager">;

  it("prefers the host session id", () => {
    const ctx = ctxWith({ getSessionId: () => "host-session-1" });
    expect(stableSessionId(ctx, 7)).toBe("host-session-1");
  });

  it.each([
    ["throwing", { getSessionId: () => { throw new Error("boom"); } }],
    ["missing", {}],
    ["empty", { getSessionId: () => "" }],
    ["blank", { getSessionId: () => "   " }],
    ["non-string", { getSessionId: () => 42 }],
  ])("falls back on %s session manager", (_label, sessionManager) => {
    expect(stableSessionId(ctxWith(sessionManager), 7)).toBe("pi-safety-session-7");
  });
});
