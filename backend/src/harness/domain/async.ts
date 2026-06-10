/**
 * A process-wide async mutex (promise-chain): serializes the wrapped critical sections. Shared by
 * the memory write policy (fact-write serialization) and the channel/cursor write-behind queues.
 * To "flush" a mutex used as a write queue, enqueue a no-op and await it: `mutex(async () => {})`.
 */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let lock: Promise<void> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = lock.then(fn);
    lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
