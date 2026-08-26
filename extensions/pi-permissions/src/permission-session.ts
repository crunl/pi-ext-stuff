// Protocol C concurrency control: generation counters, permission epochs,
// turn lifecycle, execution snapshots, mode-transition barriers, pending
// transitions, and the guardian-review controller registry. Pure state
// machine — no I/O, no host knowledge; the host supplies snapshot contents
// and performs side effects around these transitions.

import type { PermissionsConfig } from "./config.ts";
import type { SandboxPolicy } from "./sandbox.ts";
import type { PermissionMode } from "./state.ts";

export interface PendingModeTransition {
  id: number;
  turnId: number | undefined;
  phase: "active";
}

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
  private epochCounter = 0;
  private nextTransitionId = 0;
  private nextBarrierId = 0;
  private pendingTransition: PendingModeTransition | undefined;
  private inFlightBarrier: ModeTransitionBarrier | undefined;

  // --- turn lifecycle ----------------------------------------------------
  private turnPhase: "idle" | "active" | "between" = "idle";
  private turnCounter = 0;
  private currentTurnId: number | undefined;
  private executionSnapshot: PermissionExecutionSnapshot | undefined;
  private lifecycleEventsObserved = false;

  /** Registry of in-flight Guardian review abort controllers. */
  readonly reviewControllers = new Map<string, AbortController>();

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

  // --- permission epochs ---------------------------------------------------

  getEpoch(): number {
    return this.epochCounter;
  }

  epochMatches(expected: number): boolean {
    return this.epochCounter === expected;
  }

  bumpEpoch(): void {
    this.epochCounter += 1;
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
  }

  setExecutionSnapshot(snapshot: PermissionExecutionSnapshot): void {
    this.executionSnapshot = snapshot;
  }

  getExecutionSnapshot(): PermissionExecutionSnapshot | undefined {
    return this.executionSnapshot;
  }

  /** Snapshot currency: it must belong to the still-active turn. */
  currentExecutionSnapshot(): PermissionExecutionSnapshot | undefined {
    return this.turnPhase === "active" &&
      this.currentTurnId !== undefined &&
      this.executionSnapshot?.turnId === this.currentTurnId
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

  // --- pending mode transitions -------------------------------------------

  /**
   * Mint the turn-scoped token that keeps a mid-switch invalidate from tearing
   * down the live snapshot. First caller owns it for the turn.
   */
  schedulePendingTransition(): PendingModeTransition | undefined {
    if (this.turnPhase !== "active" || this.currentTurnId === undefined) return undefined;
    if (this.pendingTransition) return this.pendingTransition;
    this.pendingTransition = {
      id: ++this.nextTransitionId,
      turnId: this.currentTurnId,
      phase: "active",
    };
    return this.pendingTransition;
  }

  /** Only the lifecycle boundary that owns the token may clear it by turn. */
  clearPendingForTurn(turnId: number): void {
    if (this.pendingTransition?.turnId === turnId) this.pendingTransition = undefined;
  }

  isPendingCurrent(transition: PendingModeTransition): boolean {
    return (
      this.pendingTransition?.id === transition.id &&
      this.turnPhase === transition.phase &&
      this.currentTurnId === transition.turnId
    );
  }

  clearPendingIfCurrent(transition: PendingModeTransition): void {
    if (this.pendingTransition?.id === transition.id) this.pendingTransition = undefined;
  }

  clearPending(): void {
    this.pendingTransition = undefined;
  }

  /** Read-only view for diagnostics/snapshot capture. */
  getPendingTransition(): PendingModeTransition | undefined {
    return this.pendingTransition;
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
