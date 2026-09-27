import type { CapabilityRequest } from "./approve-for-me-engine.ts";
import type { SafetyConfig } from "./config.ts";
import { type DelegationEnvelope, isNetworkCovered, isWriteCovered } from "./delegation.ts";
import type { PermissionMode } from "./state.ts";

/**
 * The two facts about the *current* nesting that a delegation decision depends
 * on. They used to be read ambiently out of `PermissionSession` from inside the
 * `registerExtension` closure, which meant the only way to exercise any rule
 * below was to stand up the whole host and drive `agent_start` twice. Passing
 * them makes the entire policy surface a table test with no harness.
 *
 * `ceiling` is `undefined` in three distinct situations, and they are NOT
 * equivalent — see the note on `checkDelegationNetwork` below:
 *   - the outer level, where there is no envelope yet;
 *   - a sentinel nested turn, which pushes `undefined` (permission-session.ts
 *     `beginNestedTurn()` with no argument) because the child's envelope could
 *     not be resolved;
 *   - a level minted with `delegation.enabled === false`, which still pushes an
 *     envelope derived from the parent's own policy.
 */
export interface DelegationScope {
  /** Innermost active envelope, or `undefined` as above. */
  readonly ceiling: DelegationEnvelope | undefined;
  /** Current session nesting depth; the outer level is 1. */
  readonly turnDepth: number;
  /**
   * True only when EVERY active scope permits further delegation.
   *
   * This is a whole-stack reduction, not a property of `ceiling`: an outer
   * envelope can forbid re-delegation while a nearer one permits it, and the
   * correct answer is to refuse. It is carried as a precomputed fact rather than
   * re-derived from a stack here, so that the reduction stays in
   * `PermissionSession`, where it is documented and tested.
   */
  readonly allowsReDelegate: boolean;
}

export type DelegatedSpawnVerdict = { blocked: true; reason: string } | { blocked: false };

/**
 * Remaining delegation levels below the current (possibly nested) turn.
 *
 * A nested level always has a ceiling, because every mint pushes an envelope,
 * so the `turnDepth` branch only applies at the outer level. Kept as a named
 * helper because that reachability fact is the non-obvious part.
 */
function remainingDepth(config: SafetyConfig, scope: DelegationScope): number {
  if (scope.ceiling?.maxDepth !== undefined) return scope.ceiling.maxDepth;
  return config.delegation.maxDepth - (scope.turnDepth - 1);
}

/**
 * May a subagent spawn another subagent right now?
 *
 * Deciding *whether the tool is a subagent at all* is the caller's job — the
 * host adapter gates on `DELEGATED_TOOL_NAMES` before getting here, and this
 * function used to repeat that test against a name it was handed. The reason
 * strings are model-facing prose, and the depth message quotes
 * `config.delegation.maxDepth` even when the budget that actually refused came
 * from an inherited ceiling.
 */
export function checkDelegateSpawn(
  config: SafetyConfig,
  scope: DelegationScope,
): DelegatedSpawnVerdict {
  if (!scope.allowsReDelegate) {
    return {
      blocked: true,
      reason:
        "Re-delegation is disabled by the active delegation envelope: this subagent may not spawn its own subagents.",
    };
  }
  if (remainingDepth(config, scope) <= 0) {
    return {
      blocked: true,
      reason: `Delegation depth limit reached (max ${config.delegation.maxDepth} nested subagent levels): refusing to spawn a deeper subagent.`,
    };
  }
  return { blocked: false };
}

/**
 * May this write happen inside the current envelope?
 *
 * `absolutePath` must already be absolute and **lexically** resolved, never
 * canonicalized. Envelope roots *are* canonicalized and symlink-expanded when
 * the child is minted, so a canonicalized query would be compared against a
 * different path identity than the ceiling holds. The mismatch is deliberate
 * and pinned by `tests/register.test.ts` ("keeps child delegation within the
 * parent's lexical roots"); the contract here is that callers pass the value
 * they already have, not a `realpath` of it.
 *
 * Returns `undefined` when the write is permitted. A returned string is a
 * reason for the agent, and each call site raises it through its own host error
 * channel, which is why this returns a string rather than a verdict object.
 */
export function checkDelegationWrite(
  absolutePath: string,
  mode: PermissionMode,
  config: SafetyConfig,
  scope: DelegationScope,
): string | undefined {
  if (mode === "yolo" || !config.delegation.enabled) return undefined;
  const ceiling = scope.ceiling;
  if (!ceiling || isWriteCovered(absolutePath, ceiling)) return undefined;
  const roots = ceiling.writeRoots.length === 0 ? "(none)" : ceiling.writeRoots.join(", ");
  return (
    `Write to ${absolutePath} is outside the delegation envelope for this subagent ` +
    `(allowed roots: ${roots}).`
  );
}

/**
 * May this host be reached inside the current envelope?
 *
 * **This does not consult `config.delegation.enabled`, and that asymmetry with
 * `checkDelegationWrite` is real, not an oversight.** With delegation
 * configured off, a nested turn still gets an envelope derived from the parent's
 * own policy, so network access stays confined to the parent's allowed domains
 * while filesystem writes are not confined at all. Three call sites depend on
 * the current behaviour; changing it is a product decision, not a refactor, and
 * it is recorded here so the asymmetry cannot be mistaken for an oversight when
 * this file is next read.
 *
 * `absolutePath`'s lexical-resolution requirement has no counterpart here: a
 * host is compared as a normalized name, not a path.
 */
export function checkDelegationNetwork(
  host: string,
  mode: PermissionMode,
  scope: DelegationScope,
): string | undefined {
  if (mode === "yolo") return undefined;
  const ceiling = scope.ceiling;
  if (!ceiling || isNetworkCovered(host, ceiling)) return undefined;
  const hosts = ceiling.networkHosts.length === 0 ? "(none)" : ceiling.networkHosts.join(", ");
  return (
    `Network access to ${host} is outside the delegation envelope for this subagent ` +
    `(allowed hosts: ${hosts}).`
  );
}

/**
 * Apply the envelope to a batch of capability requests, returning the first
 * refusal or `undefined` when all of them are inside it.
 *
 * This is the batch form of the two rules above, and it is where the delegation
 * surface becomes *enumerated* rather than silent. `CapabilityRequest` has six
 * kinds; only two carry a destination this layer can judge:
 *
 *   - `filesystem` **write** — judged. A `read` is not a delegation concern: the
 *     sandbox policy already decides reads, and the envelope only ever narrowed
 *     what may be *changed*.
 *   - `network` — judged. Note the **port is not compared**: `checkDelegationNetwork`
 *     matches on host alone, while the runtime connection boundary at
 *     `register.ts` passes a port to `isNetworkCovered`. A `host:port` envelope
 *     entry is therefore refused statically but permitted at connection time.
 *     That divergence is a product decision, recorded rather than resolved.
 *   - `network-all`, `credential`, `process`, `external-tool` — **not judged here**,
 *     deliberately. `network-all` never reaches this path: the Engine refuses it
 *     against a non-amendment ownership before the runtime phase, and the
 *     delegation spawn gate is the only other producer. The other three are
 *     opaque host capabilities with no statically checkable destination.
 *
 * The four unjudged kinds are the fail-open surface, and they are silent: a
 * seventh kind added to `CapabilityRequest` would fall through to `undefined`
 * with nothing recording the decision. `tests/delegation-policy.test.ts` walks
 * all six so that a new kind has to be classified rather than inherited.
 *
 * `path` must already be lexically resolved by the caller — the same contract
 * `checkDelegationWrite` documents.
 */
export function checkRequestedCapabilities(
  requested: readonly CapabilityRequest[],
  mode: PermissionMode,
  config: SafetyConfig,
  scope: DelegationScope,
): string | undefined {
  for (const request of requested) {
    const violation =
      request.kind === "filesystem" && request.operation === "write"
        ? checkDelegationWrite(request.path, mode, config, scope)
        : request.kind === "network"
          ? checkDelegationNetwork(request.host, mode, scope)
          : undefined;
    if (violation) return violation;
  }
  return undefined;
}
