/**
 * Shared durable reader for the tool-bridge replies stream (`turn:{T}:replies`), used by BOTH the Claude
 * in-process bridge (`engine-entrypoint.ts`) and the Codex stdio bridge (`mcp-bridge-server.ts`). Redis is
 * injected (each bridge owns its own connection type/lifecycle), so this module has no direct `ioredis`
 * import beyond the structural `RedisLike` type — it bundles into both `.mjs` entrypoints independently
 * (see `bundle-engine.ts`).
 *
 * Two independent guards, per decision d1 (durable delivery via liveness, no wall-clock ceiling):
 *  - LOOP HARDENING + SELF-HEALING: a transient `xread` throw or a malformed frame never kills the loop; a
 *    watchdog stamps `lastTick` each cycle and force-resets a wedged connection, resuming from `lastId` so
 *    nothing queued during the outage is lost.
 *  - HEARTBEAT-GAP LIVENESS: a per-call idle timer armed at `register()` and refreshed by ANY frame for
 *    that id (progress or reply) — a genuine host-side hang shows up as a gap, never a stall on a long but
 *    still-beating call.
 */
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

export interface ToolBridgeReaderOpts {
  repliesKey: string;
  makeSub: () => RedisLike; // create a fresh blocking connection (client.duplicate() / new Redis)
  log: (msg: string) => void; // stderr writer
}

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
  constructor(private opts: ToolBridgeReaderOpts) {
    this.sub = opts.makeSub();
  }

  /** Register a pending call. The heartbeat-gap idle timer is armed IMMEDIATELY (not on first frame),
   *  so the promise is never without a liveness guard — closing the window before the host's first
   *  heartbeat. It is still pure liveness: any frame (heartbeat OR reply) for `id` resets it, so a
   *  working call survives arbitrarily long. It only fires if NOTHING arrives for HEARTBEAT_GAP_MS. */
  register(id: string): Promise<unknown> {
    const p = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.armIdle(id);
    return p;
  }

  start(): void {
    void this.loop();
    const wd = setInterval(() => {
      if (this.stop) return;
      if (Date.now() - this.lastTick > READER_STALL_MS) {
        this.opts.log(`tool-bridge reader stalled >${READER_STALL_MS}ms — resetting connection`);
        try {
          this.sub.disconnect();
        } catch {
          /* ignore */
        }
        this.sub = this.opts.makeSub(); // loop's next xread uses the new connection (see loop())
        this.lastTick = Date.now();
      }
    }, Math.min(READER_STALL_MS, 5_000));
    if (typeof wd.unref === 'function') wd.unref();
  }

  stopReader(): void {
    this.stop = true;
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
    else e.reject(new Error(frame.message));
  }

  private async loop(): Promise<void> {
    let lastId = '0-0';
    while (!this.stop) {
      let r: Array<[string, Array<[string, string[]]>]> | null;
      try {
        r = (await this.sub.xread('BLOCK', 1000, 'STREAMS', this.opts.repliesKey, lastId)) as
          | Array<[string, Array<[string, string[]]>]>
          | null;
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
            const frame = JSON.parse(f[di + 1]) as HostFrame;
            this.armIdle(frame.id); // any frame for id proves host liveness
            this.settle(frame);
          } catch (err) {
            this.opts.log(`tool-bridge reader frame parse failed (skipping): ${String(err)}`);
          }
        }
      }
    }
  }
}
