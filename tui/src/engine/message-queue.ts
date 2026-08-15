/**
 * The turn's input stream: an async iterable the SDK pulls from for as long as the query is open.
 *
 * Deliberately dumb. It used to carry an `onConsumed` callback per item, on the theory that a pull
 * was an ack — it is not. A pull only means the bytes reached the CLI's stdin; the model reads them
 * at the next request boundary, which can be tens of seconds later. The real ack arrives on the
 * OUTPUT stream as a replay frame, so the correlation lives in the drain loop and this stays a queue.
 */
export class MessageQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private waiting?: (result: IteratorResult<T>) => void;
  private closed = false;

  /**
   * Returns whether the queue took it. Closed, it did NOT — and the caller has to know, because a
   * message dropped in silence here is a steer whose text is gone and whose queued chip in the UI is
   * never cleared: only delivery clears one, and nothing will ever deliver this.
   */
  push(item: T): boolean {
    if (this.closed) return false;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
    } else {
      this.buffered.push(item);
    }
    return true;
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
        yield this.buffered.shift() as T;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
