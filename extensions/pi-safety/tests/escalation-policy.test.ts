import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type SafetyConfig } from "../src/config.ts";
import {
  type EscalationEligibilityFacts,
  escalationEligibility,
} from "../src/escalation-policy.ts";
import type { SandboxPolicy } from "../src/sandbox-policy.ts";
import type { PermissionMode } from "../src/state.ts";

/**
 * These four rules used to live inside the `registerExtension` closure, where
 * the only way to reach any of them was to stand up the whole host. The Engine
 * tests bypassed them entirely by injecting `escalationEligibility` directly,
 * which left all five reason strings unasserted anywhere in the suite.
 *
 * They are ordered and fail-closed, so the table below asserts the *reason*, not
 * just the verdict — two different refusals must never collapse into one.
 */

const HEALTHY: EscalationEligibilityFacts = {
  sandboxHealthy: true,
  delegationCeilingActive: false,
};

const NOT_HEALTHY: EscalationEligibilityFacts = { ...HEALTHY, sandboxHealthy: false };

const POLICY: SandboxPolicy = {
  filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
  network: { allowedDomains: [], deniedDomains: [] },
};

/** Distinguishes "argument omitted" from "explicitly absent". They are different
 *  inputs to the base-policy fallback and both have to be expressible. */
const ABSENT = Symbol("absent");

function snapshot(
  overrides: {
    mode?: PermissionMode;
    sandboxReady?: boolean;
    baseSandboxConfig?: SandboxPolicy | typeof ABSENT;
    denyRead?: string[];
  } = {},
) {
  const config: SafetyConfig = {
    ...DEFAULT_CONFIG,
    sandbox: {
      ...DEFAULT_CONFIG.sandbox,
      filesystem: {
        ...DEFAULT_CONFIG.sandbox.filesystem,
        denyRead: overrides.denyRead ?? DEFAULT_CONFIG.sandbox.filesystem.denyRead,
      },
    },
  };
  const base =
    overrides.baseSandboxConfig === undefined
      ? POLICY
      : overrides.baseSandboxConfig === ABSENT
        ? undefined
        : overrides.baseSandboxConfig;
  return {
    mode: overrides.mode ?? "auto",
    config,
    sandboxReady: overrides.sandboxReady ?? true,
    baseSandboxConfig: base,
  };
}

describe("command escalation eligibility", () => {
  it("grants escalation only when the sandbox is healthy and nothing narrows it", () => {
    expect(escalationEligibility(snapshot(), HEALTHY)).toEqual({
      eligible: true,
      reason: "Sandbox is healthy and neither denyRead nor a delegation ceiling apply",
    });
  });

  // Rule 1 — mode. Checked first on purpose: a healthy sandbox must not make
  // yolo escalable, so this refusal outranks every other one.
  it("refuses outside auto mode, ahead of every other rule", () => {
    const verdict = escalationEligibility(
      snapshot({ mode: "yolo" as PermissionMode, denyRead: ["/etc/shadow"] }),
      { sandboxHealthy: false, delegationCeilingActive: true },
    );
    expect(verdict).toEqual({
      eligible: false,
      reason: "Command escalation is unavailable outside auto mode",
    });
  });

  // Rule 2 — the sandbox has to actually exist and be alive. Three distinct
  // inputs collapse to one reason, which is deliberate: the reviewer cannot act
  // on "SRT never started" differently than on "SRT is poisoned".
  it.each([
    ["sandboxReady is false", { sandboxReady: false }, HEALTHY],
    ["the base policy is absent", { baseSandboxConfig: ABSENT }, HEALTHY],
    ["the backend reports unhealthy", {}, NOT_HEALTHY],
  ] as [string, Parameters<typeof snapshot>[0], EscalationEligibilityFacts][])(
    "refuses when %s",
    (_label, snapshotOverrides, facts) => {
      expect(escalationEligibility(snapshot(snapshotOverrides), facts)).toEqual({
        eligible: false,
        reason: "Sandbox executor is unavailable or poisoned",
      });
    },
  );

  // Rule 3 — Codex parity: only denied *reads* make unsandboxed execution
  // illegal. denyWrite and deniedDomains are dropped on a Codex-style bypass
  // too, so they must not appear here.
  it("refuses when denyRead is configured, and only for denyRead", () => {
    expect(escalationEligibility(snapshot({ denyRead: ["/etc/shadow"] }), HEALTHY)).toEqual({
      eligible: false,
      reason: "Command escalation cannot preserve configured denyRead rules",
    });
    const withDenyWrite = snapshot();
    withDenyWrite.config.sandbox.filesystem.denyWrite = ["/etc"];
    expect(escalationEligibility(withDenyWrite, HEALTHY).eligible).toBe(true);
  });

  // Rule 4 — a nested agent may not escalate past its envelope.
  it("refuses inside an active delegation envelope", () => {
    expect(
      escalationEligibility(snapshot(), { ...HEALTHY, delegationCeilingActive: true }),
    ).toEqual({
      eligible: false,
      reason: "Command escalation is outside the active delegation envelope",
    });
  });

  // The override exists because a nested turn can mint a narrower base policy
  // than the snapshot carries. Both directions matter: an override must be able
  // to *supply* the policy, and omitting it must fall back to the snapshot's
  // rather than to "absent".
  it("prefers an explicit base policy and falls back to the snapshot's own", () => {
    const base = { baseSandboxConfig: ABSENT } as const;
    expect(escalationEligibility(snapshot(base), HEALTHY).eligible).toBe(false);
    expect(
      escalationEligibility(snapshot(base), { ...HEALTHY, baseSandboxPolicy: POLICY }),
    ).toEqual({
      eligible: true,
      reason: "Sandbox is healthy and neither denyRead nor a delegation ceiling apply",
    });
    expect(
      escalationEligibility(snapshot(), { ...HEALTHY, baseSandboxPolicy: undefined }).eligible,
    ).toBe(true);
  });

  // Ordering is the contract, so assert the full precedence in one place rather
  // than inferring it from the individual cases above. Each step removes exactly
  // one problem so the next rule becomes reachable — otherwise an earlier rule
  // masks the later ones and the ladder proves nothing.
  it("reports the first applicable rule when several would refuse", () => {
    const DENY_READ = ["/etc/shadow"];
    const NESTED = { ...HEALTHY, delegationCeilingActive: true };
    const BOTH_FACTS = { sandboxHealthy: false, delegationCeilingActive: true };

    const ladder: [string, string][] = [
      [
        "mode",
        escalationEligibility(
          snapshot({ mode: "yolo", sandboxReady: false, denyRead: DENY_READ }),
          BOTH_FACTS,
        ).reason,
      ],
      [
        "sandbox",
        escalationEligibility(snapshot({ sandboxReady: false, denyRead: DENY_READ }), BOTH_FACTS)
          .reason,
      ],
      ["denyRead", escalationEligibility(snapshot({ denyRead: DENY_READ }), HEALTHY).reason],
      ["delegation", escalationEligibility(snapshot(), NESTED).reason],
    ];

    expect(ladder).toEqual([
      ["mode", "Command escalation is unavailable outside auto mode"],
      ["sandbox", "Sandbox executor is unavailable or poisoned"],
      ["denyRead", "Command escalation cannot preserve configured denyRead rules"],
      ["delegation", "Command escalation is outside the active delegation envelope"],
    ]);
  });
});
