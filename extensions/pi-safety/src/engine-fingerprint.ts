/**
 * The identities the Engine uses to decide whether two actions are the same.
 *
 * Two questions are asked with these, and they deliberately answer
 * differently:
 *
 * - `callFingerprint` includes the call id, so re-issuing the identical command
 *   as a new tool call does not silently reuse the old approval.
 * - `invocationFingerprint` without the call id keys the per-turn approval
 *   cache, where the same command under the same turn is the same question.
 *
 * Keeping them together makes that difference comparable at a glance. They
 * are pure, and every import here is `import type` from `engine-types.ts`, which
 * keeps this module off the Engine's value graph *and* its type graph.
 */
import { resolve } from "node:path";
import type { InvocationCall, InvocationOwnership, TurnSnapshot } from "./engine-types.ts";
import { fingerprintValue } from "./policy-primitives.ts";

/** The snapshot fields that make a turn's identity; nothing else is read. */
type FingerprintIdentity = Pick<TurnSnapshot, "sessionId" | "turnId" | "configFingerprint">;

export function invocationFingerprint(
  identity: FingerprintIdentity,
  call: InvocationCall,
  ownership: InvocationOwnership,
  includeCallId: boolean,
): string {
  const action = {
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    configFingerprint: identity.configFingerprint,
    ownership,
    tool: call.tool.toLowerCase(),
    input: call.input,
    cwd: resolve(call.cwd),
    metadata: call.metadata,
  };
  return fingerprintValue(includeCallId ? { ...action, id: call.id } : action);
}

export function callFingerprint(
  identity: FingerprintIdentity,
  call: InvocationCall,
  ownership: InvocationOwnership,
): string {
  return invocationFingerprint(identity, call, ownership, true);
}
