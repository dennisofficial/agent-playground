type Entry<T> = { item: T; onConsumed?: () => void };

export class MessageQueue<T> implements AsyncIterable<T> {
  private readonly buffered: Entry<T>[] = [];
  private waiting?: (result: IteratorResult<Entry<T>>) => void;
  private closed = false;

  push(item: T, onConsumed?: () => void): void {
    if (this.closed) return;
    const entry: Entry<T> = { item, ...(onConsumed ? { onConsumed } : {}) };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: entry, done: false });
    } else {
      this.buffered.push(entry);
    }
  }

  /** Queued but not yet pulled by the SDK — what the working line still shows as pending. */
  get pending(): number {
    return this.buffered.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.buffered.length > 0) {
        const entry = this.buffered.shift() as Entry<T>;
        entry.onConsumed?.();
        yield entry.item;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<Entry<T>>>((resolve) => {
        this.waiting = resolve;
      });
      if (next.done) return;
      next.value.onConsumed?.();
      yield next.value.item;
    }
  }
}
