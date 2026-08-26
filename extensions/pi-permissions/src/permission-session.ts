// Protocol C concurrency control: generation counters, permission epochs,
// mode-transition barriers, pending transitions, and the guardian-review
// controller registry. Pure state machine — no I/O, no host knowledge; the
// host supplies turn-phase facts as method arguments where they gate behavior.

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

export interface TurnFacts {
  phase: "idle" | "active" | "between";
  activeTurnId: number | undefined;
}

export class PermissionSession {
  private generationCounter = 0;
  private epochCounter = 0;
  private nextTransitionId = 0;
  private nextBarrierId = 0;
  private pendingTransition: PendingModeTransition | undefined;
  private inFlightBarrier: ModeTransitionBarrier | undefined;

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

  // --- pending mode transitions -------------------------------------------

  /**
   * Mint the turn-scoped token that keeps a mid-switch invalidate from tearing
   * down the live snapshot. First caller owns it for the turn.
   */
  schedulePendingTransition(turn: TurnFacts): PendingModeTransition | undefined {
    if (turn.phase !== "active" || turn.activeTurnId === undefined) return undefined;
    if (this.pendingTransition) return this.pendingTransition;
    this.pendingTransition = {
      id: ++this.nextTransitionId,
      turnId: turn.activeTurnId,
      phase: "active",
    };
    return this.pendingTransition;
  }

  /** Only the lifecycle boundary that owns the token may clear it by turn. */
  clearPendingForTurn(turnId: number): void {
    if (this.pendingTransition?.turnId === turnId) this.pendingTransition = undefined;
  }

  isPendingCurrent(transition: PendingModeTransition, turn: TurnFacts): boolean {
    return (
      this.pendingTransition?.id === transition.id &&
      turn.phase === transition.phase &&
      turn.activeTurnId === transition.turnId
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
