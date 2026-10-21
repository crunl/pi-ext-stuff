/**
 * The identities the Engine uses to decide whether two actions are the same.
 *
 * Three questions are asked with these, and they deliberately answer
 * differently:
 *
 * - `callFingerprint` includes the call id, so re-issuing the identical command
 *   as a new tool call does not silently reuse the old approval.
 * - `invocationFingerprint` without the call id keys the per-turn approval
 *   cache, where the same command under the same turn is the same question.
 * - `retryFingerprint` drops both the turn and the call id, because arming a
 *   manual retry asks to review the action again in the next turn rather than
 *   to replay the old envelope.
 *
 * Keeping them together makes those differences comparable at a glance. They
 * are pure, and every import here is `import type` from `engine-types.ts`, which
 * keeps this module off the Engine's value graph *and* its type graph.
 */
import { resolve } from "node:path";
import type {
  CapabilityRequest,
  InvocationCall,
  InvocationOwnership,
  TurnSnapshot,
} from "./engine-types.ts";
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

export function retryFingerprint(
  identity: FingerprintIdentity,
  call: InvocationCall,
  ownership: InvocationOwnership,
  grantScope: readonly CapabilityRequest[],
  admissionScope: readonly CapabilityRequest[],
  justification?: string,
): string {
  // A manually armed retry is a request to review the same action in the next
  // turn, not permission to replay the old tool-call envelope. Keep the
  // session/config/ownership/action identity, but deliberately omit both the
  // old turn id and old call id so Pi can issue a fresh invocation.
  return fingerprintValue({
    sessionId: identity.sessionId,
    configFingerprint: identity.configFingerprint,
    ownership,
    tool: call.tool.toLowerCase(),
    input: call.input,
    cwd: resolve(call.cwd),
    metadata: call.metadata,
    grantScope,
    admissionScope,
    justification,
  });
}
