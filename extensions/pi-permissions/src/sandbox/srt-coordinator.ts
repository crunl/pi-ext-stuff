type Waiter = {
  allowPoisoned: boolean;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export type DetachedAbortHandler = () => Error | undefined;

export type SrtFaultReason = "initialization" | "reset" | "cleanup" | "restore" | "drain-timeout";

/**
 * The deadline is an internal lifecycle budget for a cancelled operation. It
 * is deliberately independent of the caller's command timeout: that timeout
 * only releases the caller, while this one decides when an unsettled SRT
 * operation becomes a persistent host fault.
 */
export const SRT_DRAIN_TIMEOUT_MS = 15_000;

type DetachedRunOptions = {
  /** Activation/reset are the only operations allowed to run after a fault. */
  allowPoisoned?: boolean;
};

/**
 * The SRT package exposes one mutable process-global manager. A lock scoped to
 * an extension instance is therefore insufficient: two Pi registrations or
 * ordinary tools could otherwise swap its config while a child is still alive.
 * The production Guardian uses its own worker and never enters this coordinator.
 */
export class SrtProcessCoordinator {
  private active = false;
  private poisonReason: SrtFaultReason | undefined;
  private drainingOwner: symbol | undefined;
  private readonly queue: Waiter[] = [];

  get isPoisoned(): boolean {
    return this.poisonReason !== undefined;
  }

  get isDraining(): boolean {
    return this.drainingOwner !== undefined;
  }

  poisonedError(): Error {
    const reason = this.poisonReason ?? "unknown";
    return new Error(`executor is poisoned after a previous SRT ${reason} failure`);
  }

  markPoisoned(reason: SrtFaultReason): void {
    this.poisonReason ??= reason;
    this.rejectPoisonedWaiters();
  }

  private beginDraining(): () => void {
    const owner = Symbol("srt-drain");
    this.drainingOwner = owner;
    const timer = setTimeout(() => {
      if (this.drainingOwner === owner) this.markPoisoned("drain-timeout");
    }, SRT_DRAIN_TIMEOUT_MS);
    timer.unref?.();
    return () => {
      if (this.drainingOwner !== owner) return;
      this.drainingOwner = undefined;
      clearTimeout(timer);
    };
  }

  /** Clear only the persistent fault; a drain owner is always cleared by its lease. */
  clearPoison(): void {
    this.poisonReason = undefined;
  }

  async runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal, false);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Run a mutable operation while allowing its caller to stop waiting at a
   * deadline. The operation remains attached to the lease until it settles;
   * this is required because SRT's initialize/wrap/reset methods mutate a
   * process-global singleton. An abort callback is invoked only after the
   * lease has started, so an aborted queued waiter cannot poison the runtime.
   */
  runExclusiveDetached<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
    onAbort?: DetachedAbortHandler,
    options: DetachedRunOptions = {},
  ): Promise<T> {
    return this.acquire(signal, options.allowPoisoned === true).then(
      (release) =>
        new Promise<T>((resolve, reject) => {
          let operationSettled = false;
          let callerSettled = false;
          let finishDraining: (() => void) | undefined;

          const cleanupSignal = (): void => {
            if (signal) signal.removeEventListener("abort", handleAbort);
          };
          const releaseLease = (): void => {
            cleanupSignal();
            release();
          };
          const finish = (callback: () => void): void => {
            if (operationSettled) return;
            operationSettled = true;
            finishDraining?.();
            finishDraining = undefined;
            releaseLease();
            callback();
          };
          const handleAbort = (): void => {
            if (operationSettled || callerSettled) return;
            callerSettled = true;
            finishDraining = this.beginDraining();
            let error: Error;
            try {
              error = onAbort?.() ?? new Error("aborted");
            } catch (abortError) {
              error = abortError instanceof Error ? abortError : new Error(String(abortError));
            }
            reject(error);
          };

          // A signal can fire after acquire() grants the lease but before the
          // operation is started. Treat that as a cancelled queued waiter:
          // release without invoking the operation or poisoning SRT.
          if (signal?.aborted) {
            callerSettled = true;
            releaseLease();
            reject(new Error("aborted"));
            return;
          }
          signal?.addEventListener("abort", handleAbort, { once: true });
          if (signal?.aborted) {
            callerSettled = true;
            releaseLease();
            reject(new Error("aborted"));
            return;
          }

          let operationPromise: Promise<T>;
          try {
            operationPromise = operation();
          } catch (error) {
            operationPromise = Promise.reject(error);
          }
          Promise.resolve(operationPromise).then(
            (value) =>
              finish(() => {
                if (!callerSettled) resolve(value);
              }),
            (error: unknown) =>
              finish(() => {
                if (!callerSettled) reject(error);
              }),
          );
        }),
    );
  }

  private acquire(signal: AbortSignal | undefined, allowPoisoned: boolean): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    if (this.isPoisoned && !allowPoisoned) return Promise.reject(this.poisonedError());

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { allowPoisoned, resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(new Error("aborted"));
          this.drain();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    const waiter = this.queue.shift();
    if (!waiter) return;
    if (this.isPoisoned && !waiter.allowPoisoned) {
      this.removeWaiterAbortListener(waiter);
      waiter.reject(this.poisonedError());
      this.drain();
      return;
    }
    if (waiter.signal?.aborted) {
      this.removeWaiterAbortListener(waiter);
      waiter.reject(new Error("aborted"));
      this.drain();
      return;
    }
    this.active = true;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      this.active = false;
      this.drain();
    });
  }

  private rejectPoisonedWaiters(): void {
    if (this.queue.length === 0) return;
    const retained: Waiter[] = [];
    for (const waiter of this.queue) {
      if (waiter.allowPoisoned) {
        retained.push(waiter);
        continue;
      }
      this.removeWaiterAbortListener(waiter);
      waiter.reject(this.poisonedError());
    }
    this.queue.splice(0, this.queue.length, ...retained);
    this.drain();
  }

  private removeWaiterAbortListener(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}

/** One lock for every SRT invocation in this Node process. */
export const srtProcessCoordinator = new SrtProcessCoordinator();
