/**
 * The log bus: a tiny pub/sub for observability that must reach the UI without tearing the Ink render.
 * Modules BELOW the conductor (worker, reconcile, workspace) used to write straight to `process.stderr`,
 * which corrupts the live terminal frame. They publish here instead; the UI subscribes and renders each
 * record as a keyed debug node. A standalone module (mirroring `channel`) so those deep modules don't have
 * to import the conductor (which would be a cycle). A non-TUI surface can simply not subscribe.
 */
export interface LogRecord {
  /** Stable id for the UI key. */
  id: string;
  kind: 'worker' | 'memory' | 'reminders' | 'workspace';
  /** The employee this is about, when there is one. */
  by?: string;
  text: string;
}

class LogBus {
  private subs = new Set<(r: LogRecord) => void>();
  private seq = 0;

  /** Publish a record. `id` is assigned here so callers pass only the payload. Never throws/blocks. */
  publish(rec: Omit<LogRecord, 'id'>): void {
    const full: LogRecord = { ...rec, id: `log-${this.seq++}` };
    for (const cb of this.subs) cb(full);
  }

  subscribe(cb: (r: LogRecord) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
}

export const logBus = new LogBus();
