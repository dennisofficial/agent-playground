import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface, Interface } from 'node:readline';

export type AppServerClientOptions = {
  codexHome: string;
  codexPathOverride?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

type JsonRpcId = number | string;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type NotificationListener = (params: unknown) => void;
type ServerRequestHandler = (params: unknown) => Promise<unknown> | unknown;

type InboundMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const DEFAULT_CODEX_BINARY = 'codex';
const APP_SERVER_SUBCOMMAND = 'app-server';
const HANDLER_ERROR_CODE = -32000;
const METHOD_NOT_FOUND_CODE = -32601;

/**
 * Low-level JSON-RPC-2.0-over-stdio peer for the `codex app-server` process.
 *
 * Framing is newline-delimited JSON (one complete object per line, both directions) and the
 * `"jsonrpc":"2.0"` field is omitted on the wire. Handles all three inbound shapes: responses to our
 * requests (correlated by id), server notifications, and server-initiated requests we must answer.
 */
export class AppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader: Interface;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Map<string, NotificationListener[]>();
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private nextId = 1;
  private closed = false;
  private exited = false;
  private exitPromise: Promise<void>;

  constructor(opts: AppServerClientOptions) {
    // When a full binary path is provided (chiefly tests pointing at a fake server), trust `args`
    // verbatim; only the default `codex` binary gets the implicit `app-server` subcommand prepended.
    const binary = opts.codexPathOverride ?? DEFAULT_CODEX_BINARY;
    const args = [
      ...(opts.codexPathOverride ? [] : [APP_SERVER_SUBCOMMAND]),
      ...(opts.args ?? []),
    ];

    this.child = spawn(binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, CODEX_HOME: opts.codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.reader = createInterface({ input: this.child.stdout });
    this.reader.on('line', (line) => this.handleLine(line));

    this.child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[codex app-server] ${chunk.toString()}`);
    });

    this.exitPromise = new Promise<void>((resolve) => {
      const onDone = (reason: Error) => {
        this.exited = true;
        this.rejectAllPending(reason);
        resolve();
      };
      this.child.on('error', (err) => onDone(err instanceof Error ? err : new Error(String(err))));
      this.child.on('exit', (code, signal) =>
        onDone(new Error(`codex app-server exited (code=${code}, signal=${signal})`)),
      );
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.exited) {
      return Promise.reject(new Error('codex app-server process has exited'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  onNotification(method: string, cb: NotificationListener): void {
    const list = this.notificationListeners.get(method) ?? [];
    list.push(cb);
    this.notificationListeners.set(method, list);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise;
      return;
    }
    this.closed = true;

    if (!this.exited) {
      this.child.stdin.end();
      const timer = setTimeout(() => {
        if (!this.exited) this.child.kill();
      }, 1_000);
      timer.unref?.();
      await this.exitPromise;
      clearTimeout(timer);
    }
    this.reader.close();
  }

  private write(msg: unknown): void {
    if (this.exited) return;
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let msg: InboundMessage;
    try {
      msg = JSON.parse(trimmed) as InboundMessage;
    } catch {
      // A single unparseable line must not tear down the client — surface and keep reading.
      process.stderr.write(`[codex app-server] non-JSON line: ${trimmed}\n`);
      return;
    }

    const hasId = msg.id !== undefined && msg.id !== null;
    const isResponse = hasId && (msg.result !== undefined || msg.error !== undefined);

    if (isResponse) {
      this.resolveResponse(msg);
      return;
    }
    if (msg.method !== undefined && hasId) {
      void this.handleServerRequest(msg.id as JsonRpcId, msg.method, msg.params);
      return;
    }
    if (msg.method !== undefined) {
      this.dispatchNotification(msg.method, msg.params);
    }
  }

  private resolveResponse(msg: InboundMessage): void {
    const pending = this.pending.get(msg.id as JsonRpcId);
    if (!pending) return;
    this.pending.delete(msg.id as JsonRpcId);
    if (msg.error) {
      pending.reject(new Error(msg.error.message));
    } else {
      pending.resolve(msg.result);
    }
  }

  private dispatchNotification(method: string, params: unknown): void {
    const listeners = this.notificationListeners.get(method);
    if (!listeners) return;
    for (const cb of listeners) cb(params);
  }

  private async handleServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) {
      this.write({ id, error: { code: METHOD_NOT_FOUND_CODE, message: `No handler for ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.write({ id, error: { code: HANDLER_ERROR_CODE, message } });
    }
  }

  private rejectAllPending(reason: Error): void {
    for (const [, pending] of this.pending) pending.reject(reason);
    this.pending.clear();
  }
}
