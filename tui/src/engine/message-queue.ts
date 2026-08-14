type Entry<T> = { item: T; onConsumed?: () => void };

export class MessageQueue<T> implements AsyncIterable<T> {
  private readonly buffered: Entry<T>[] = [];
  private waiting?: (result: IteratorResult<Entry<T>>) => void;
  private closed = false;

  /**
   * Returns whether the queue took it. Closed, it did NOT — and the caller has to know, because a
   * message dropped in silence here is a steer whose text is gone and whose queued chip in the UI is
   * never cleared: only delivery clears one, and nothing will ever deliver this.
   */
  push(item: T, onConsumed?: () => void): boolean {
    if (this.closed) return false;
    const entry: Entry<T> = { item, ...(onConsumed ? { onConsumed } : {}) };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: entry, done: false });
    } else {
      this.buffered.push(entry);
    }
    return true;
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
