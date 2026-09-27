import { describe, expect, it } from "vitest";
import type { CapabilityRequest } from "../src/approve-for-me-engine.ts";
import { DEFAULT_CONFIG, type SafetyConfig } from "../src/config.ts";
import type { DelegationEnvelope } from "../src/delegation.ts";
import {
  checkDelegateSpawn,
  checkDelegationNetwork,
  checkDelegationWrite,
  checkRequestedCapabilities,
  type DelegationScope,
} from "../src/delegation-policy.ts";
import type { PermissionMode } from "../src/state.ts";

/**
 * These three rules used to be closures over `PermissionSession` inside the
 * 2820-line `registerExtension`. Their only live facts — the innermost envelope
 * and the whole-stack re-delegation reduction — were read ambiently, so the sole
 * way to exercise any of them was to build a full host harness and drive
 * `agent_start` twice. Everything below runs with no harness at all.
 *
 * The reason strings are asserted, not just the verdicts: each one is model-facing
 * prose, and two different refusals must never collapse into one message.
 */

function config(overrides: Partial<SafetyConfig["delegation"]> = {}): SafetyConfig {
  return {
    ...DEFAULT_CONFIG,
    delegation: { ...DEFAULT_CONFIG.delegation, ...overrides },
  };
}

const CEILING: DelegationEnvelope = {
  writeRoots: ["/repo/sub"],
  networkHosts: ["api.example.com"],
  allowReDelegate: true,
  maxDepth: 3,
};

/** The outer level: no envelope yet, so the budget comes from config. */
const OUTER: DelegationScope = {
  ceiling: undefined,
  turnDepth: 1,
  allowsReDelegate: true,
};

const NESTED: DelegationScope = {
  ceiling: CEILING,
  turnDepth: 2,
  allowsReDelegate: true,
};

describe("delegation policy", () => {
  describe("subagent spawn", () => {
    it("allows a spawn with budget left", () => {
      expect(checkDelegateSpawn(config({ maxDepth: 3 }), NESTED)).toEqual({ blocked: false });
      expect(checkDelegateSpawn(config({ maxDepth: 3 }), OUTER)).toEqual({ blocked: false });
    });

    // The reduction is over the WHOLE stack, not the innermost envelope: an
    // outer scope can forbid re-delegation while a nearer one permits it. That
    // reduction is computed by PermissionSession and arrives here as a fact, so
    // this test pins the consumer of the fact, not the reduction itself.
    it("refuses when any active scope forbids re-delegation", () => {
      const verdict = checkDelegateSpawn(config(), { ...NESTED, allowsReDelegate: false });
      expect(verdict).toEqual({
        blocked: true,
        reason:
          "Re-delegation is disabled by the active delegation envelope: this subagent may not spawn its own subagents.",
      });
    });

    // Two independent sources of the budget, and the message quotes the CONFIG
    // value even when an inherited ceiling is what actually refused.
    it.each([
      [
        "an inherited ceiling exhausted its budget",
        config({ maxDepth: 9 }),
        { ...NESTED, ceiling: { ...CEILING, maxDepth: 0 } },
      ],
      ["the config budget is exhausted at the outer level", config({ maxDepth: 0 }), OUTER],
      [
        "the config budget is exhausted one level down",
        config({ maxDepth: 1 }),
        { ...OUTER, turnDepth: 2 },
      ],
    ])("refuses when %s", (_label, cfg, scope) => {
      expect(checkDelegateSpawn(cfg, scope)).toEqual({
        blocked: true,
        reason: `Delegation depth limit reached (max ${cfg.delegation.maxDepth} nested subagent levels): refusing to spawn a deeper subagent.`,
      });
    });
  });

  describe("write", () => {
    it("permits a path the envelope covers", () => {
      expect(checkDelegationWrite("/repo/sub/file.txt", "auto", config(), NESTED)).toBeUndefined();
    });

    it.each([
      ["yolo", "yolo" as PermissionMode, config()],
      ["delegation configured off", "auto" as PermissionMode, config({ enabled: false })],
    ])("bypasses the envelope under %s", (_label, mode, cfg) => {
      expect(checkDelegationWrite("/anywhere/at/all.txt", mode, cfg, NESTED)).toBeUndefined();
    });

    // No envelope means no constraint — including on a sentinel nested turn,
    // where the fail-closed comes from the missing execution context rather than
    // from this rule.
    it("permits anything when there is no envelope", () => {
      expect(checkDelegationWrite("/anywhere.txt", "auto", config(), OUTER)).toBeUndefined();
    });

    it("refuses outside the envelope and names the allowed roots", () => {
      expect(checkDelegationWrite("/repo/other.txt", "auto", config(), NESTED)).toBe(
        "Write to /repo/other.txt is outside the delegation envelope for this subagent " +
          "(allowed roots: /repo/sub).",
      );
    });

    it("reports an empty root list as (none)", () => {
      const empty: DelegationScope = { ...NESTED, ceiling: { ...CEILING, writeRoots: [] } };
      expect(checkDelegationWrite("/repo/other.txt", "auto", config(), empty)).toContain(
        "(allowed roots: (none))",
      );
    });
  });

  describe("network", () => {
    it("permits a host the envelope covers", () => {
      expect(checkDelegationNetwork("api.example.com", "auto", NESTED)).toBeUndefined();
    });

    it("bypasses the envelope under yolo", () => {
      expect(checkDelegationNetwork("elsewhere.example", "yolo", NESTED)).toBeUndefined();
    });

    it("permits anything when there is no envelope", () => {
      expect(checkDelegationNetwork("elsewhere.example", "auto", OUTER)).toBeUndefined();
    });

    it("refuses outside the envelope and names the allowed hosts", () => {
      expect(checkDelegationNetwork("elsewhere.example", "auto", NESTED)).toBe(
        "Network access to elsewhere.example is outside the delegation envelope for this " +
          "subagent (allowed hosts: api.example.com).",
      );
    });

    it("reports an empty host list as (none)", () => {
      const empty: DelegationScope = { ...NESTED, ceiling: { ...CEILING, networkHosts: [] } };
      expect(checkDelegationNetwork("elsewhere.example", "auto", empty)).toContain(
        "(allowed hosts: (none))",
      );
    });
  });

  // Pinned deliberately, as current behaviour. `checkDelegationWrite` consults
  // `delegation.enabled`; `checkDelegationNetwork` does not. A nested turn still
  // receives an envelope when delegation is configured off, so with delegation
  // off the child's filesystem writes are unconstrained while its network access
  // is still confined to the parent's allowed domains.
  //
  // Three call sites depend on this. Changing it is a product decision, so the
  // test records what it is today and will fail loudly if it ever moves.
  it("confines network but not writes when delegation is configured off", () => {
    const off = config({ enabled: false });
    expect(checkDelegationWrite("/anywhere.txt", "auto", off, NESTED)).toBeUndefined();
    expect(checkDelegationNetwork("elsewhere.example", "auto", NESTED)).toContain(
      "outside the delegation envelope",
    );
  });

  // The point of moving this out of the adapter: the six `CapabilityRequest`
  // kinds were dispatched inline, two judged and four falling through to
  // "allowed" with nothing recording that. Walking all six here means a seventh
  // kind has to be classified rather than silently inherited.
  describe("capability requests", () => {
    const ALL: readonly [string, CapabilityRequest, boolean][] = [
      [
        "filesystem write inside the envelope",
        { kind: "filesystem", operation: "write", path: "/repo/sub/a" },
        true,
      ],
      [
        "filesystem write outside it",
        { kind: "filesystem", operation: "write", path: "/repo/a" },
        false,
      ],
      [
        "filesystem read outside it",
        { kind: "filesystem", operation: "read", path: "/repo/a" },
        true,
      ],
      ["network host inside the envelope", { kind: "network", host: "api.example.com" }, true],
      ["network host outside it", { kind: "network", host: "elsewhere.example" }, false],
      ["network-all", { kind: "network-all" }, true],
      ["credential", { kind: "credential", name: "aws" }, true],
      ["process", { kind: "process", executable: "/bin/sh" }, true],
      ["external-tool", { kind: "external-tool", provider: "acme", name: "search" }, true],
    ];

    it.each(ALL)("classifies %s", (_label, request, permitted) => {
      const verdict = checkRequestedCapabilities([request], "auto", config(), NESTED);
      if (permitted) {
        expect(verdict).toBeUndefined();
      } else {
        expect(verdict).toContain("outside the delegation envelope");
      }
    });

    it("covers every kind the type admits", () => {
      // A guard, not a comment: if a kind is added to CapabilityRequest and not
      // listed above, this count no longer matches and the enumeration is stale.
      const covered = new Set(ALL.map(([, request]) => request.kind));
      expect(covered.size).toBe(6);
    });

    it("returns the first refusal in a batch", () => {
      const batch: CapabilityRequest[] = [
        { kind: "filesystem", operation: "write", path: "/repo/also-outside" },
        { kind: "network", host: "elsewhere.example" },
      ];
      expect(checkRequestedCapabilities(batch, "auto", config(), NESTED)).toContain(
        "Write to /repo/also-outside",
      );
    });

    it("permits an empty batch", () => {
      expect(checkRequestedCapabilities([], "auto", config(), NESTED)).toBeUndefined();
    });

    // A write outside the envelope is refused even when yolo would let the
    // individual rule through — no: yolo bypasses the individual rules, so this
    // documents the actual behaviour rather than the desirable one.
    it("bypasses every judgement under yolo", () => {
      const batch: CapabilityRequest[] = [
        { kind: "filesystem", operation: "write", path: "/anywhere.txt" },
        { kind: "network", host: "elsewhere.example" },
      ];
      expect(checkRequestedCapabilities(batch, "yolo", config(), NESTED)).toBeUndefined();
    });
  });
});
