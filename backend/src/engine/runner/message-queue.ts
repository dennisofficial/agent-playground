export class MessageQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private waiting?: (r: IteratorResult<T>) => void;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
    } else {
      this.buffered.push(item);
    }
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
