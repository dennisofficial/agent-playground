/**
 * The channel: the shared, append-only message log that IS the conversation. Everyone — you and every
 * bot — writes to it asynchronously; nobody waits. Each message gets a monotonic `seq` that doubles as
 * the cursor coordinate: a bot tracks how far it has consumed via `since(cursor)`. This is the CLI's
 * stand-in for a Slack channel's event stream — the dispatcher is the seam a Slack adapter replaces.
 */
export interface ChannelMsg {
  /** Monotonic position — the cursor coordinate. */
  seq: number;
  /** Stable id (for dedupe + UI keys). */
  id: string;
  /** Display name ("Dennis", "Alex"). */
  author: string;
  /** Scope id ("dennis", "alex"). */
  authorId: string;
  /** Set when a bot authored it. */
  authorBotId?: string;
  text: string;
}

class Channel {
  private log: ChannelMsg[] = [];
  private subs = new Set<() => void>();
  private nextSeq = 0;

  /** Append a message (or update one re-emitted with the same id). Synchronous, never blocks. */
  append(msg: Omit<ChannelMsg, 'seq'>): ChannelMsg {
    const existing = this.log.findIndex((m) => m.id === msg.id);
    if (existing >= 0) {
      this.log[existing] = { ...this.log[existing], ...msg };
      this.notify();
      return this.log[existing];
    }
    const full: ChannelMsg = { ...msg, seq: this.nextSeq++ };
    this.log.push(full);
    this.notify();
    return full;
  }

  /** Messages at or after a cursor seq (what a bot hasn't consumed yet). */
  since(cursor: number): ChannelMsg[] {
    return this.log.filter((m) => m.seq >= cursor);
  }

  /** The next seq that will be assigned — i.e. the count of messages so far; the high-water cursor. */
  get length(): number {
    return this.nextSeq;
  }

  snapshot(): ChannelMsg[] {
    return [...this.log];
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private notify(): void {
    for (const cb of this.subs) cb();
  }
}

export const channel = new Channel();
