type LeaseKind = "shared" | "exclusive";

interface Waiter {
  kind: LeaseKind;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class SandboxExecutionCoordinator {
  private activeReaders = 0;
  private writerActive = false;
  private readonly queue: Waiter[] = [];

  async runShared<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire("shared", signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async runExclusive<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire("exclusive", signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(kind: LeaseKind, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { kind, resolve, reject, signal };
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
    if (this.writerActive || this.queue.length === 0) return;

    const first = this.queue[0]!;
    if (first.kind === "exclusive") {
      if (this.activeReaders > 0) return;
      this.queue.shift();
      this.writerActive = true;
      this.grant(first, () => {
        this.writerActive = false;
        this.drain();
      });
      return;
    }

    while (this.queue[0]?.kind === "shared" && !this.writerActive) {
      const waiter = this.queue.shift()!;
      this.activeReaders += 1;
      this.grant(waiter, () => {
        this.activeReaders -= 1;
        this.drain();
      });
    }
  }

  private grant(waiter: Waiter, releaseLease: () => void): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      releaseLease();
    });
  }
}
