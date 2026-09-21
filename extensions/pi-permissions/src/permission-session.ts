// Concurrency control for generations, turn lifecycle, execution snapshots,
// and mode-transition barriers. Pure state machine — no I/O, no host
// knowledge; the host supplies snapshot contents and performs side effects
// around these transitions.

import type { PermissionsConfig } from "./config.ts";
import type { DelegationAuditLink, DelegationEnvelope } from "./delegation.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";
import type { PermissionMode } from "./state.ts";

export interface ModeTransitionBarrier {
  id: number;
  completion: Promise<boolean>;
  settle(readyForNextTurn: boolean): void;
}

/** Immutable view of the config/sandbox world a specific turn started under. */
export interface PermissionExecutionSnapshot {
  turnId: number;
  mode: PermissionMode;
  config: PermissionsConfig;
  baseSandboxConfig?: SandboxPolicy;
  sandboxReady: boolean;
}

export class PermissionSession {
  private generationCounter = 0;
  private nextBarrierId = 0;
  private inFlightBarrier: ModeTransitionBarrier | undefined;

  // --- turn lifecycle ----------------------------------------------------
  private turnPhase: "idle" | "active" | "between" = "idle";
  private turnCounter = 0;
  private currentTurnId: number | undefined;
  private executionSnapshot: PermissionExecutionSnapshot | undefined;
  private lifecycleEventsObserved = false;
  private turnDepth = 0;
  /**
   * True after an agent_end was accounted while a turn was active and before
   * its paired agent_settled arrived. The host emits end+settled per agent
   * level (including nested subagents), so settled must not finish twice.
   * Cleared by any begin/reset; a stray flag self-heals on the next turn.
   */
  private endAwaitingSettle = false;
  /**
   * Per-nesting-level execution snapshots and delegation ceilings.
   * Index 0 is the outermost nested level; the outer turn itself lives in
   * executionSnapshot. Pushed by beginNestedTurn, popped by finishNestedTurn.
   */
  private nestedSnapshots: Array<PermissionExecutionSnapshot | undefined> = [];
  private delegationStack: Array<DelegationEnvelope | undefined> = [];
  private delegationAudit: DelegationAuditLink[] = [];

  /**
   * Bound for nested agent turns. A leaked agent_end (crashed subagent)
   * can strand depth, but the next outer beginTurn/resetTurn zeroes it,
   * so the blast radius is one outer turn. Saturation (not growth) on
   * overflow keeps finishNestedTurn accounting exact.
   */
  static readonly maxNestedTurnDepth = 32;

  // --- generations -------------------------------------------------------

  getGeneration(): number {
    return this.generationCounter;
  }

  isCurrentGeneration(expected: number): boolean {
    return expected === this.generationCounter;
  }

  bumpGeneration(): void {
    this.generationCounter += 1;
  }

  // --- turn lifecycle ------------------------------------------------------

  getTurnPhase(): "idle" | "active" | "between" {
    return this.turnPhase;
  }

  allocateTurnId(): number {
    this.turnCounter += 1;
    return this.turnCounter;
  }

  beginTurn(turnId: number): void {
    this.currentTurnId = turnId;
    this.turnPhase = "active";
    this.turnDepth = 1;
    this.endAwaitingSettle = false;
    this.nestedSnapshots = [];
    this.delegationStack = [];
    this.delegationAudit = [];
  }

  getTurnDepth(): number {
    return this.turnDepth;
  }

  beginNestedTurn(nested?: {
    snapshot?: PermissionExecutionSnapshot;
    envelope?: DelegationEnvelope;
    audit?: DelegationAuditLink;
  }): boolean {
    if (this.turnPhase !== "active" || this.currentTurnId === undefined) return false;
    if (this.turnDepth >= PermissionSession.maxNestedTurnDepth) return false;
    this.turnDepth += 1;
    this.endAwaitingSettle = false;
    this.nestedSnapshots.push(nested?.snapshot);
    this.delegationStack.push(nested?.envelope);
    if (nested?.audit) this.delegationAudit.push(nested.audit);
    return true;
  }

  /** Innermost active delegation ceiling, or undefined at the outer level. */
  activeDelegationCeiling(): DelegationEnvelope | undefined {
    return this.delegationStack.at(-1);
  }

  /**
   * Whether every active delegation scope permits another delegation.
   *
   * The audit chain is intentionally not consulted here: it is historical
   * evidence, while this predicate describes only scopes that still govern
   * the current nested turn.
   */
  activeDelegationAllowsReDelegate(): boolean {
    return this.delegationStack.every((envelope) => envelope?.allowReDelegate !== false);
  }

  /** True when the innermost nested session layer owns an Engine turn. */
  activeNestedTurnHasSnapshot(): boolean {
    return this.turnDepth > 1 && this.nestedSnapshots.at(-1) !== undefined;
  }

  /** Audit chain of parent → child delegations for the active turn. */
  delegationAuditTrail(): readonly DelegationAuditLink[] {
    return this.delegationAudit;
  }

  getCurrentTurnId(): number | undefined {
    return this.currentTurnId;
  }

  /** Record an agent_end accounted while a turn was active. */
  noteEndAwaitingSettle(): void {
    this.endAwaitingSettle = true;
  }

  /**
   * Consume the pending end/settled pairing. Returns true when this settled
   * pairs with a preceding end (turn accounting already ran — skip finish).
   */
  takeEndAwaitingSettle(): boolean {
    if (!this.endAwaitingSettle) return false;
    this.endAwaitingSettle = false;
    return true;
  }

  finishNestedTurn(): number | undefined {
    if (this.turnPhase !== "active") return undefined;
    if (this.turnDepth > 1) {
      this.turnDepth -= 1;
      this.nestedSnapshots.pop();
      this.delegationStack.pop();
      return undefined;
    }
    return this.finishTurn();
  }

  isCurrentTurn(turnId: number): boolean {
    return this.currentTurnId === turnId;
  }

  /** Close the active turn; returns the closing id, or undefined when idle. */
  finishTurn(): number | undefined {
    if (this.turnPhase !== "active") return undefined;
    const closingTurnId = this.currentTurnId;
    this.executionSnapshot = undefined;
    this.currentTurnId = undefined;
    this.turnPhase = "between";
    this.turnDepth = 0;
    return closingTurnId;
  }

  /** agent_settled quiescence: an ended turn fully leaves the between state. */
  settleBetween(): void {
    if (this.turnPhase === "between") this.turnPhase = "idle";
  }

  /** Hard reset to idle (extension init / session shutdown). */
  resetTurn(): void {
    this.executionSnapshot = undefined;
    this.currentTurnId = undefined;
    this.turnPhase = "idle";
    this.turnDepth = 0;
    this.endAwaitingSettle = false;
    this.nestedSnapshots = [];
    this.delegationStack = [];
    this.delegationAudit = [];
  }

  setExecutionSnapshot(snapshot: PermissionExecutionSnapshot): void {
    this.executionSnapshot = snapshot;
  }

  /**
   * Step-boundary mode apply: rewrite applied mode (and optional lifecycle
   * facts) on the root snapshot and every nested child. Never allocates a
   * turn or clears grants.
   */
  refreshExecutionSnapshotMode(
    mode: PermissionMode,
    facts?: { sandboxReady?: boolean; baseSandboxConfig?: SandboxPolicy },
  ): void {
    if (this.turnPhase !== "active") return;
    const apply = (snapshot: PermissionExecutionSnapshot | undefined): void => {
      if (!snapshot) return;
      snapshot.mode = mode;
      if (facts?.sandboxReady !== undefined) snapshot.sandboxReady = facts.sandboxReady;
      if (facts?.baseSandboxConfig !== undefined) {
        snapshot.baseSandboxConfig = facts.baseSandboxConfig;
      }
    };
    apply(this.executionSnapshot);
    for (const nested of this.nestedSnapshots) apply(nested);
  }

  getExecutionSnapshot(): PermissionExecutionSnapshot | undefined {
    return this.executionSnapshot;
  }

  /** Snapshot currency: it must belong to the still-active turn. */
  currentExecutionSnapshot(): PermissionExecutionSnapshot | undefined {
    if (this.turnPhase !== "active" || this.currentTurnId === undefined) return undefined;
    // Inside a nested agent the innermost child snapshot governs; it was
    // minted from the outer snapshot so it inherits the turn's identity.
    if (this.nestedSnapshots.length > 0) return this.nestedSnapshots.at(-1);
    return this.executionSnapshot?.turnId === this.currentTurnId
      ? this.executionSnapshot
      : undefined;
  }

  /**
   * Record that a real host lifecycle event arrived. Direct tool-hook
   * invocations no longer qualify as implicit turns once this is set.
   */
  markLifecycleEvent(): void {
    this.lifecycleEventsObserved = true;
  }

  /** session_start: a fresh host session forgets prior lifecycle activity. */
  clearLifecycleEvents(): void {
    this.lifecycleEventsObserved = false;
  }

  hasObservedLifecycle(): boolean {
    return this.lifecycleEventsObserved;
  }

  // --- mode transition barriers --------------------------------------------

  createBarrier(): ModeTransitionBarrier {
    let resolveCompletion!: (readyForNextTurn: boolean) => void;
    let settled = false;
    const barrier: ModeTransitionBarrier = {
      id: ++this.nextBarrierId,
      completion: new Promise<boolean>((resolvePromise) => {
        resolveCompletion = resolvePromise;
      }),
      settle(readyForNextTurn) {
        if (settled) return;
        settled = true;
        resolveCompletion(readyForNextTurn);
      },
    };
    this.inFlightBarrier = barrier;
    return barrier;
  }

  settleBarrier(barrier: ModeTransitionBarrier, readyForNextTurn: boolean): void {
    barrier.settle(readyForNextTurn);
    if (readyForNextTurn && this.inFlightBarrier?.id === barrier.id) {
      this.inFlightBarrier = undefined;
    }
  }

  cancelInFlightBarrier(): void {
    const barrier = this.inFlightBarrier;
    if (!barrier) return;
    barrier.settle(false);
    if (this.inFlightBarrier?.id === barrier.id) {
      this.inFlightBarrier = undefined;
    }
  }

  // --- mode mutation serialization -----------------------------------------

  private mutationTail: Promise<void> = Promise.resolve();

  /**
   * Serialize mode mutations so they never interleave. The generation is
   * captured at enqueue time; an operation superseded by a later bump
   * resolves to undefined without running.
   */
  runModeMutation<T>(operation: (generation: number) => Promise<T>): Promise<T | undefined> {
    const generation = this.getGeneration();
    const execute = async (): Promise<T | undefined> => {
      if (!this.isCurrentGeneration(generation)) return undefined;
      return operation(generation);
    };
    const result = this.mutationTail.then(execute, execute);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Whether a mode transition is still settling (blocks snapshot creation). */
  hasInFlightBarrier(): boolean {
    return this.inFlightBarrier !== undefined;
  }

  /** Read-only view for callers awaiting an in-flight barrier completion. */
  getInFlightBarrier(): ModeTransitionBarrier | undefined {
    return this.inFlightBarrier;
  }

  /** Clear the in-flight barrier only if it is still the same one. */
  clearInFlightIfCurrent(barrier: ModeTransitionBarrier): void {
    if (this.inFlightBarrier?.id === barrier.id) {
      this.inFlightBarrier = undefined;
    }
  }
}
