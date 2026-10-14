// Cooperative shutdown: on SIGTERM/SIGINT the adapters finish the deposit they're settling, save
// their checkpoint and return, instead of being killed mid-wait. Every loop checks `requested`
// before starting new work, and sleeps through `sleep()` so a shutdown wakes it immediately.

export interface Shutdown {
  readonly requested: boolean;
  request(): void;
  /// Resolves after `ms`, or as soon as shutdown is requested - whichever comes first.
  sleep(ms: number): Promise<void>;
}

export function makeShutdown(): Shutdown {
  let requested = false;
  const wakers = new Set<() => void>();

  return {
    get requested() {
      return requested;
    },
    request() {
      if (requested) return;
      requested = true;
      for (const wake of wakers) wake();
    },
    sleep(ms) {
      if (requested) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wakers.delete(done);
          resolve();
        }
        wakers.add(done);
      });
    },
  };
}
