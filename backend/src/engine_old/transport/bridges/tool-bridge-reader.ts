type RedisLike = {
  xread(...args: unknown[]): Promise<unknown>;
  disconnect(): void;
};

type HostFrame =
  | { t: 'tool_response'; id: string; result: unknown }
  | { t: 'tool_error'; id: string; message: string }
  | { t: 'tool_progress'; id: string; ts: number };

const READER_STALL_MS = Number(process.env['TOOL_READER_STALL_MS']) || 15_000; // no tick → reset conn
const HEARTBEAT_GAP_MS = Number(process.env['TOOL_HEARTBEAT_GAP_MS']) || 90_000; // gap → host hang

export type ToolBridgeReaderOpts = {
  repliesKey: string;
  makeSub: () => RedisLike; // create a fresh blocking connection (client.duplicate() / new Redis)
  log: (msg: string) => void; // stderr writer
};

export class ToolBridgeReader {
  private pending = new Map<
    string,
    {
      resolve: (r: unknown) => void;
      reject: (e: Error) => void;
      idle?: ReturnType<typeof setTimeout>;
    }
  >();
  private stop = false;
  private lastTick = Date.now();
  private sub: RedisLike;
  private watchdog?: ReturnType<typeof setInterval>;
  constructor(private opts: ToolBridgeReaderOpts) {
    this.sub = opts.makeSub();
  }

  register(id: string): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  cancel(id: string): void {
    const e = this.pending.get(id);
    if (e?.idle) clearTimeout(e.idle);
    this.pending.delete(id);
  }

  start(): void {
    void this.loop().catch((err) => {
      this.opts.log(`tool-bridge reader loop stopped unexpectedly: ${String(err)}`);
    });
    this.watchdog = setInterval(
      () => {
        if (this.stop) return;
        if (Date.now() - this.lastTick > READER_STALL_MS) {
          this.opts.log(`tool-bridge reader stalled >${READER_STALL_MS}ms — resetting connection`);
          try {
            this.sub.disconnect();
          } catch {}
          try {
            this.sub = this.opts.makeSub(); // loop's next xread uses the new connection (see loop())
          } catch (err) {
            this.opts.log(`tool-bridge reader reconnect failed (retrying): ${String(err)}`);
          }
          this.lastTick = Date.now();
        }
      },
      Math.min(READER_STALL_MS, 5_000),
    );
    if (typeof this.watchdog.unref === 'function') this.watchdog.unref();
  }

  stopReader(): void {
    this.stop = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private armIdle(id: string): void {
    const e = this.pending.get(id);
    if (!e) return;
    if (e.idle) clearTimeout(e.idle);
    e.idle = setTimeout(() => {
      this.pending.delete(id);
      e.reject(new Error(`host stopped responding (no heartbeat for ${HEARTBEAT_GAP_MS}ms)`));
    }, HEARTBEAT_GAP_MS);
    if (typeof e.idle.unref === 'function') e.idle.unref();
  }

  private settle(frame: HostFrame): void {
    const e = this.pending.get(frame.id);
    if (!e) return;
    if (frame.t === 'tool_progress') return; // liveness only — armIdle already refreshed the timer
    if (e.idle) clearTimeout(e.idle);
    this.pending.delete(frame.id);
    if (frame.t === 'tool_response') e.resolve(frame.result);
    else e.reject(new Error(frame.message || 'host tool error (no message)'));
  }

  private async loop(): Promise<void> {
    let lastId = '0-0';
    while (!this.stop) {
      let r: Array<[string, Array<[string, string[]]>]> | null;
      try {
        r = (await this.sub.xread('BLOCK', 1000, 'STREAMS', this.opts.repliesKey, lastId)) as Array<
          [string, Array<[string, string[]]>]
        > | null;
      } catch (err) {
        this.opts.log(`tool-bridge reader xread failed (retrying): ${String(err)}`);
        await new Promise((res) => setTimeout(res, 250));
        continue; // NEVER let a transient error kill the loop
      }
      this.lastTick = Date.now(); // liveness stamp — even on a null (idle) read
      if (!r) continue;
      for (const [, entries] of r) {
        for (const [eid, f] of entries) {
          lastId = eid;
          try {
            const di = f.indexOf('data');
            if (di < 0) continue;
            const frame = parseHostFrame(JSON.parse(f[di + 1]));
            if (!frame) {
              this.opts.log('tool-bridge reader got malformed frame (skipping)');
              continue;
            }
            this.armIdle(frame.id); // any valid frame for id proves host liveness
            this.settle(frame);
          } catch (err) {
            this.opts.log(`tool-bridge reader frame parse failed (skipping): ${String(err)}`);
          }
        }
      }
    }
  }
}

function parseHostFrame(value: unknown): HostFrame | null {
  if (!value || typeof value !== 'object') return null;
  const frame = value as Record<string, unknown>;
  if (typeof frame['id'] !== 'string') return null;
  if (frame['t'] === 'tool_response') {
    return { t: 'tool_response', id: frame['id'], result: frame['result'] };
  }
  if (frame['t'] === 'tool_error' && typeof frame['message'] === 'string') {
    return { t: 'tool_error', id: frame['id'], message: frame['message'] };
  }
  if (frame['t'] === 'tool_progress' && typeof frame['ts'] === 'number') {
    return { t: 'tool_progress', id: frame['id'], ts: frame['ts'] };
  }
  return null;
}
