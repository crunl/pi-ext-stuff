import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  buildTurnTraceRecord,
  nextMode,
  requiresNetworkQuiescence,
  requiresSandbox,
  stableSessionId,
  type TurnTraceSegments,
  traceSpan,
  turnTraceEnabled,
} from "../src/register-support.ts";
import type { SandboxPolicy } from "../src/sandbox-policy.ts";

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
    [
      "throwing",
      {
        getSessionId: () => {
          throw new Error("boom");
        },
      },
    ],
    ["missing", {}],
    ["empty", { getSessionId: () => "" }],
    ["blank", { getSessionId: () => "   " }],
    ["non-string", { getSessionId: () => 42 }],
  ])("falls back on %s session manager", (_label, sessionManager) => {
    expect(stableSessionId(ctxWith(sessionManager), 7)).toBe("pi-safety-session-7");
  });
});

describe("turn tracing", () => {
  it("gates on PI_SAFETY_TRACE=1 only", () => {
    expect(turnTraceEnabled({ PI_SAFETY_TRACE: "1" })).toBe(true);
    expect(turnTraceEnabled({})).toBe(false);
    expect(turnTraceEnabled({ PI_SAFETY_TRACE: "0" })).toBe(false);
    expect(turnTraceEnabled({ PI_SAFETY_TRACE: "true" })).toBe(false);
  });

  it("accumulates named spans and excludes review from extension_ms", async () => {
    const segments: TurnTraceSegments = {};
    await traceSpan(true, segments, "risk", async () => undefined);
    await traceSpan(true, segments, "risk", async () => undefined);
    await traceSpan(true, segments, "execute", async () => undefined);
    // A visibly slow review span: extension_ms must not absorb it.
    await traceSpan(true, segments, "review", async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    const record = buildTurnTraceRecord("id-1", "bash", "auto", segments);
    expect(record.schema).toBe(1);
    expect(Object.keys(record.segments).sort()).toEqual(["execute", "review", "risk"]);
    // extension_ms equals the non-review spans only.
    expect(record.extension_ms).toBeCloseTo(record.segments.risk! + record.segments.execute!, 6);
    expect(record.extension_ms).toBeLessThan(record.segments.review!);
  });

  it("passes through untouched when the gate is off", async () => {
    const segments: TurnTraceSegments = {};
    const marker = Symbol("result");
    const result = await traceSpan(false, segments, "risk", async () => marker);
    expect(result).toBe(marker);
    expect(Object.keys(segments)).toHaveLength(0);
  });
});
