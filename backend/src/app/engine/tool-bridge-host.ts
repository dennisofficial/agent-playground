/**
 * R1 — host-side of the bidirectional tool-bridge frame protocol.
 *
 * When a turn's `RunEngineArgs.toolBridge` is set the exec's stdin stays open and the in-container
 * entrypoint can emit `{t:'tool_request', id, name, args}` frames on stdout interleaved with the
 * existing `event`/`final`/`error` frames. The host answers each with a `{t:'tool_response', id,
 * result}` or `{t:'tool_error', id, message}` frame written back on stdin, correlating by `id`.
 *
 * `ToolBridgeHost` wires together:
 *   - an NDJSON line parser that the docker/local runner feeds stdout chunks into;
 *   - a per-request Promise map so a `tool_request` suspends until the host impl resolves;
 *   - per-thread scoping enforcement (requests naming a different threadId are denied);
 *   - a write callback the host keeps open until the final/error frame closes the turn.
 *
 * This module is Nest-free (no DI decorators) — the `DockerEngineRunner` and `LocalToolBridgeRunner`
 * both instantiate it directly.
 */

import type { HostFrame, ToolBridgeOptions, ToolRequestFrame } from './engine.types';

/**
 * Execute ONE host-bridge tool request and return the correlated reply frame. Transport-agnostic — the
 * pipe host writes the reply to stdin, the Redis runner XADDs it to `turn:{T}:replies`. Enforces the
 * per-thread scope (a request naming another thread is denied) and never throws (errors → `tool_error`).
 */
export async function dispatchToolRequest(
  bridge: ToolBridgeOptions,
  req: ToolRequestFrame,
): Promise<HostFrame> {
  const { id, name, args } = req;
  if (typeof args['threadId'] === 'string' && args['threadId'] !== bridge.threadId) {
    return {
      t: 'tool_error',
      id,
      message: `Thread scope violation: tool '${name}' requested for thread '${args['threadId']}' but this exec belongs to thread '${bridge.threadId}'`,
    };
  }
  const impl = bridge.tools[name];
  if (!impl) return { t: 'tool_error', id, message: `Unknown tool: '${name}'` };
  try {
    const result = await impl(args);
    return { t: 'tool_response', id, result };
  } catch (err) {
    return { t: 'tool_error', id, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Every frame type the in-container side may emit. Existing types + the new tool_request. */
export type InboundFrame =
  | { t: 'event'; e: unknown }
  | { t: 'final'; r: unknown }
  | { t: 'error'; message: string; auth?: boolean; sessionId?: string }
  | ToolRequestFrame;

/**
 * Host-side coordinator for one bidirectional tool-bridge turn.
 *
 * Usage:
 * 1. Instantiate with `toolBridge` options and a write callback.
 * 2. Feed stdout chunks into `feedChunk()` as they arrive from the exec.
 * 3. The host calls the tool impls and writes correlated responses automatically.
 * 4. Await `closed` — resolves when a `final` or `error` frame is received (the turn ended).
 *    At that point you may end stdin via the provided end callback.
 */
export class ToolBridgeHost {
  /** Resolves with the `final` frame payload when the turn ends. */
  readonly closed: Promise<void>;

  private readonly _resolve: () => void;
  private readonly _reject: (err: Error) => void;
  private _buf = '';
  private _done = false;

  /** Pending tool_request handlers keyed by id. */
  private readonly _pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

  /** Parsed frames (event/final/error) for the caller to consume. */
  private readonly _frames: InboundFrame[] = [];
  /** Callback to notify when a non-tool frame is ready. */
  private _onFrame?: (f: InboundFrame) => void;

  constructor(
    private readonly bridge: ToolBridgeOptions,
    /** Write a frame to the exec's stdin (NDJSON line). */
    private readonly writeToStdin: (line: string) => void,
    /** Called when the turn emits a final/error frame so the caller can end stdin. */
    private readonly onTurnEnd: () => void,
  ) {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    this.closed = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this._resolve = resolve;
    this._reject = reject;
  }

  /** Register a callback that receives each non-tool-request frame (event / final / error). */
  onFrame(cb: (f: InboundFrame) => void): void {
    this._onFrame = cb;
    // drain anything buffered before the callback was registered
    for (const f of this._frames) cb(f);
    this._frames.length = 0;
  }

  /** Feed a raw stdout chunk into the NDJSON parser. Thread-safe (synchronous). */
  feedChunk(chunk: string): void {
    this._buf += chunk;
    let nl: number;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (line) this._parseLine(line);
    }
  }

  /** Flush any remaining buffered content (call after the stream ends). */
  flush(): void {
    const line = this._buf.trim();
    this._buf = '';
    if (line) this._parseLine(line);
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────

  private _parseLine(line: string): void {
    let frame: InboundFrame;
    try {
      frame = JSON.parse(line) as InboundFrame;
    } catch {
      // Non-JSON noise — ignore (diagnostics go to stderr).
      return;
    }

    if (frame.t === 'tool_request') {
      // Dispatch asynchronously; don't block the parser.
      void this._dispatch(frame);
      return;
    }

    // Propagate to the caller.
    if (this._onFrame) {
      this._onFrame(frame);
    } else {
      this._frames.push(frame);
    }

    // Turn end — resolve the `closed` promise.
    if ((frame.t === 'final' || frame.t === 'error') && !this._done) {
      this._done = true;
      this.onTurnEnd();
      this._resolve();
    }
  }

  private async _dispatch(req: ToolRequestFrame): Promise<void> {
    this._respond(await dispatchToolRequest(this.bridge, req));
  }

  private _respond(frame: HostFrame): void {
    this.writeToStdin(`${JSON.stringify(frame)}\n`);
  }
}
