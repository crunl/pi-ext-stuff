/**
 * Engine denial circuit.
 *
 * One invariant, one module: the Engine stops sending work to the reviewer once
 * a run of denials (or a full denial window of denials) proves the reviewer is
 * refusing everything, and the first success or non-denial review result clears
 * that state. The consecutive count, the bounded window, and the open/closed
 * bit are three views of that single decision, so they are written together
 * here and can only be read together: a reader gets the counters as one
 * `readout()` and the gate as `open()`.
 *
 * The threshold policy and the clear-on-success rule deliberately live in this
 * implementation. A caller of the Engine cannot open the circuit early by
 * writing a count, and cannot re-open it after a success.
 *
 * Lifetime: one circuit per Engine turn scope. The Engine replaces the whole
 * circuit (rather than resetting fields) when the turn, session, or
 * configuration generation changes, so no denial can leak across that seam.
 */

/** Denial thresholds the circuit enforces; omit any field to take the default. */
export interface DenialCircuitPolicy {
  readonly maxConsecutiveDenials: number;
  readonly denialWindowSize: number;
  readonly maxWindowDenials: number;
}

/** The counters the circuit is willing to publish: always a pair, never alone. */
export interface DenialReadout {
  readonly consecutiveDenials: number;
  readonly recentDenials: number;
}

export interface DenialCircuit {
  /** Record one denial; may open the circuit. */
  recordDenial(): void;
  /** Record one non-denial review result; clears the run and closes the circuit. */
  recordSuccess(): void;
  /** Current counters, as a single read of the same state the gate uses. */
  readout(): DenialReadout;
  /** True while the circuit refuses further reviewer work. */
  open(): boolean;
}

const DEFAULT_MAX_CONSECUTIVE_DENIALS = 3;
const DEFAULT_DENIAL_WINDOW_SIZE = 50;
const DEFAULT_MAX_WINDOW_DENIALS = 10;

export function createDenialCircuit(policy: Partial<DenialCircuitPolicy> = {}): DenialCircuit {
  const maxConsecutiveDenials = policy.maxConsecutiveDenials ?? DEFAULT_MAX_CONSECUTIVE_DENIALS;
  const denialWindowSize = policy.denialWindowSize ?? DEFAULT_DENIAL_WINDOW_SIZE;
  const maxWindowDenials = policy.maxWindowDenials ?? DEFAULT_MAX_WINDOW_DENIALS;

  const window: boolean[] = [];
  let consecutiveDenials = 0;
  let circuitOpen = false;

  const recordWindow = (denied: boolean): void => {
    window.push(denied);
    if (window.length > denialWindowSize) {
      window.splice(0, window.length - denialWindowSize);
    }
  };

  return {
    recordDenial: (): void => {
      recordWindow(true);
      consecutiveDenials += 1;
      if (
        consecutiveDenials >= maxConsecutiveDenials ||
        window.filter(Boolean).length >= maxWindowDenials
      ) {
        circuitOpen = true;
      }
    },
    recordSuccess: (): void => {
      recordWindow(false);
      consecutiveDenials = 0;
      circuitOpen = false;
    },
    readout: (): DenialReadout => ({
      consecutiveDenials,
      recentDenials: window.filter(Boolean).length,
    }),
    open: (): boolean => circuitOpen,
  };
}
