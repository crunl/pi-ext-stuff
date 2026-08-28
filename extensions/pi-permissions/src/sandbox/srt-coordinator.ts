type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export type DetachedAbortHandler = () => Error | undefined;

/**
 * The SRT package exposes one mutable process-global manager. A lock scoped to
 * an extension instance is therefore insufficient: two Pi registrations (or
 * the Guardian and a normal tool) could otherwise swap the singleton's
 * config while a child is still alive.
 */
export class SrtProcessCoordinator {
  private active = false;
  private poisoned = false;
  private readonly queue: Waiter[] = [];

  get isPoisoned(): boolean {
    return this.poisoned;
  }

  markPoisoned(): void {
    this.poisoned = true;
  }

  clearPoison(): void {
    this.poisoned = false;
  }

  async runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
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
  ): Promise<T> {
    return this.acquire(signal).then(
      (release) =>
        new Promise<T>((resolve, reject) => {
          let operationSettled = false;
          let callerSettled = false;

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
            releaseLease();
            callback();
          };
          const handleAbort = (): void => {
            if (operationSettled || callerSettled) return;
            callerSettled = true;
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

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
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
    if (waiter.signal?.aborted) {
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
}

/** One lock for every SRT invocation in this Node process. */
export const srtProcessCoordinator = new SrtProcessCoordinator();
