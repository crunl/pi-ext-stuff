/**
 * Defensive copies of the values the Engine accepts from its caller.
 *
 * Every entry point clones before storing, because a caller that keeps a
 * reference could otherwise mutate a lease or a turn snapshot after the Engine
 * has already fingerprinted it. Each clone also refuses values it cannot copy
 * faithfully: a non-cloneable input becomes a load error at the boundary
 * instead of a half-copied action later.
 *
 * These live apart from the Engine so the copy rules can be read in one place.
 * Every import below is `import type`, so this module adds no runtime edge back
 * to `approve-for-me-engine.ts` and the value graph stays acyclic.
 */
import { resolve } from "node:path";
import type {
  AdmissionPlan,
  CapabilityLease,
  Invocation,
  InvocationCall,
  PermissionAmendment,
  TurnSnapshot,
} from "./approve-for-me-engine.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

export function clonePolicy(policy: SandboxPolicy | undefined): SandboxPolicy | undefined {
  return policy === undefined ? undefined : structuredClone(policy);
}

export function cloneLease(lease: CapabilityLease): CapabilityLease {
  const policy = clonePolicy(lease.policy);
  return {
    mode: lease.mode,
    ...(policy === undefined ? {} : { policy }),
  };
}

export function cloneMetadata(metadata: unknown): InvocationCall["metadata"] {
  if (metadata === undefined) return undefined;
  try {
    return structuredClone(metadata);
  } catch {
    throw new Error("Invocation metadata must be structured-cloneable");
  }
}

export function cloneInvocationCall(call: InvocationCall): InvocationCall {
  const metadata = cloneMetadata(call.metadata);
  let input: unknown;
  try {
    input = structuredClone(call.input);
  } catch {
    throw new Error("Invocation input must be structured-cloneable");
  }
  return {
    id: call.id,
    tool: call.tool,
    input,
    cwd: resolve(call.cwd),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

export function cloneInvocation<T, ReviewContext>(
  invocation: Invocation<T, ReviewContext>,
): Invocation<T, ReviewContext> {
  let admission: AdmissionPlan | undefined;
  let intent: PermissionAmendment | undefined;
  const runtimeDenialPolicy = invocation.runtimeDenialPolicy;
  if (
    runtimeDenialPolicy !== undefined &&
    runtimeDenialPolicy !== "terminal" &&
    runtimeDenialPolicy !== "review-and-retry"
  ) {
    throw new Error("Invocation runtime denial policy is invalid");
  }
  try {
    admission =
      invocation.admission === undefined ? undefined : structuredClone(invocation.admission);
    intent = invocation.intent === undefined ? undefined : structuredClone(invocation.intent);
  } catch {
    throw new Error("Invocation authorization evidence must be structured-cloneable");
  }
  return {
    ownership: invocation.ownership,
    call: cloneInvocationCall(invocation.call),
    ...(admission === undefined ? {} : { admission }),
    ...(intent === undefined ? {} : { intent }),
    ...(runtimeDenialPolicy === undefined ? {} : { runtimeDenialPolicy }),
    reviewContext: invocation.reviewContext,
    executor: invocation.executor,
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
  };
}

export function cloneSnapshot(snapshot: TurnSnapshot): TurnSnapshot {
  return {
    sessionId: snapshot.sessionId,
    turnId: snapshot.turnId,
    mode: snapshot.mode,
    cwd: resolve(snapshot.cwd),
    configFingerprint: snapshot.configFingerprint,
    baseSandboxPolicy: clonePolicy(snapshot.baseSandboxPolicy),
    sandboxReady: snapshot.sandboxReady,
    transcript: snapshot.transcript === undefined ? [] : structuredClone(snapshot.transcript),
  };
}
