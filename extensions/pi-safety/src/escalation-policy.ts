import type { EscalationEligibility } from "./approve-for-me-engine.ts";
import type { PermissionExecutionSnapshot } from "./permission-session.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

/**
 * The three facts the rules below need that the caller owns, injected rather
 * than read from ambient adapter state.
 *
 * `sandboxHealthy` and `delegationCeilingActive` are decisions, not data: the
 * adapter derives the first from the SRT backend's liveness and the second from
 * the nesting stack. Reading them here instead would make this module
 * untestable without a live sandbox and a live session.
 *
 * `baseSandboxPolicy` overrides the snapshot's own value. It exists because a
 * nested turn can mint a narrower base policy than the one the snapshot carries,
 * and eligibility must be judged against the policy that would actually apply.
 * Omitting it, or passing `undefined`, falls back to the snapshot's value.
 */
export interface EscalationEligibilityFacts {
  readonly sandboxHealthy: boolean;
  readonly delegationCeilingActive: boolean;
  readonly baseSandboxPolicy?: SandboxPolicy;
}

type EscalationSnapshot = Pick<
  PermissionExecutionSnapshot,
  "mode" | "config" | "sandboxReady" | "baseSandboxConfig"
>;

/**
 * Whether a frozen Bash call may be escalated out of the sandbox for one run.
 *
 * Four ordered fail-closed rules. Order is load-bearing and is the whole
 * contract: a call in yolo is refused for its mode before anything else is
 * consulted, so a healthy sandbox cannot make yolo escalable, and a delegation
 * ceiling is only reported once the sandbox question is settled.
 *
 * Codex parity, stated once here rather than at each call site: only denied
 * *reads* make unsandboxed execution illegal. `denyWrite` and `deniedDomains`
 * are dropped on a Codex-style bypass too, so neither appears in these rules.
 *
 * This used to live inside the `registerExtension` closure, which meant the only
 * way to exercise any of these rules was to stand up the whole host: the Engine
 * tests bypass it by injecting `escalationEligibility` directly. That left all
 * five reason strings unasserted.
 */
export function escalationEligibility(
  snapshot: EscalationSnapshot,
  facts: EscalationEligibilityFacts,
): EscalationEligibility {
  const baseSandboxConfig = facts.baseSandboxPolicy ?? snapshot.baseSandboxConfig;

  if (snapshot.mode !== "auto") {
    return { eligible: false, reason: "Command escalation is unavailable outside auto mode" };
  }
  if (!snapshot.sandboxReady || baseSandboxConfig === undefined || !facts.sandboxHealthy) {
    return {
      eligible: false,
      reason: "Sandbox executor is unavailable or poisoned",
    };
  }
  if (snapshot.config.sandbox.filesystem.denyRead.length > 0) {
    return {
      eligible: false,
      reason: "Command escalation cannot preserve configured denyRead rules",
    };
  }
  if (facts.delegationCeilingActive) {
    return {
      eligible: false,
      reason: "Command escalation is outside the active delegation envelope",
    };
  }
  return {
    eligible: true,
    reason: "Sandbox is healthy and neither denyRead nor a delegation ceiling apply",
  };
}
