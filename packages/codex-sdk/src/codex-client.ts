import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppServerClient } from './app-server-client.js';
import type {
  CodexApprovalDecision,
  CodexApprovalKind,
  CodexApprovalRequest,
  CodexEffort,
  CodexEvent,
  CodexInput,
  CodexItem,
  CodexSandbox,
  CodexThread,
  CodexTokenUsage,
  CodexTurnError,
  CodexTurnResult,
  CodexTurnStatus,
} from './types.js';

export type CodexTurnHandlers = {
  onEvent: (e: CodexEvent) => void;
  onApproval?: (req: CodexApprovalRequest) => Promise<CodexApprovalDecision> | CodexApprovalDecision;
};

export type CodexClientOptions = {
  codexHome: string;
  codexPathOverride?: string;
  // Extra args appended after the spawned binary. Chiefly lets tests point the spawn at a fake
  // app-server script; production callers rely on the default `codex app-server` invocation.
  args?: string[];
  experimentalApi?: boolean;
  clientInfo?: { name?: string; title?: string; version?: string };
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type StartTurnOptions = {
  model?: string;
  effort?: CodexEffort;
  sandbox?: CodexSandbox;
  signal?: AbortSignal;
};

type ActiveTurn = {
  threadId: string;
  turnId?: string;
  handlers: CodexTurnHandlers;
  usage: CodexTokenUsage;
  settle: (result: CodexTurnResult) => void;
  fail: (err: Error) => void;
  interruptRequested: boolean;
};

const APPROVAL_METHODS: Record<string, CodexApprovalKind> = {
  'item/commandExecution/requestApproval': 'commandExecution',
  'item/fileChange/requestApproval': 'fileChange',
  'item/permissions/requestApproval': 'permissions',
};

const NOTIFICATION_METHODS = [
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/patchUpdated',
  'turn/diff/updated',
  'thread/tokenUsage/updated',
] as const;

const TURN_STATUSES: readonly CodexTurnStatus[] = ['completed', 'interrupted', 'failed'];

// thread/start (and thread/resume) take a kebab-case `SandboxMode` string on their `sandbox` field.
function toThreadSandbox(sandbox: CodexSandbox): string {
  switch (sandbox) {
    case 'readOnly':
      return 'read-only';
    case 'workspaceWrite':
      return 'workspace-write';
    case 'dangerFullAccess':
      return 'danger-full-access';
  }
}

// turn/start has no `sandbox` field at all — it takes a discriminated `sandboxPolicy` object whose
// `type` discriminator is camelCase (matching CodexSandbox verbatim).
function toTurnSandboxPolicy(sandbox: CodexSandbox): { type: CodexSandbox } {
  return { type: sandbox };
}

/**
 * High-level typed Codex API over the app-server protocol: thread/turn control, mid-turn steer,
 * per-call approval interception, and a discriminated event stream. Atlas-agnostic — auth is just a
 * caller-supplied `codexHome` directory path.
 */
export class CodexClient {
  private readonly codexHome: string;
  private readonly opts: CodexClientOptions;
  private client?: AppServerClient;
  // One turn per thread at a time (v1 does not support concurrent turns on a thread).
  private readonly activeTurns = new Map<string, ActiveTurn>();

  constructor(opts: CodexClientOptions) {
    this.opts = opts;
    this.codexHome = opts.codexHome;
  }

  async init(): Promise<void> {
    const client = new AppServerClient({
      codexHome: this.codexHome,
      codexPathOverride: this.opts.codexPathOverride,
      args: this.opts.args,
      env: this.opts.env,
      cwd: this.opts.cwd,
    });
    this.client = client;

    this.registerApprovalHandlers(client);
    this.registerNotificationHandlers(client);

    await client.request('initialize', {
      clientInfo: {
        name: this.opts.clientInfo?.name ?? 'codex-sdk',
        title: this.opts.clientInfo?.title ?? 'Codex SDK',
        version: this.opts.clientInfo?.version ?? '0.1.0',
      },
      capabilities: { experimentalApi: this.opts.experimentalApi ?? true },
    });
    // Ack the handshake; harmless if the server ignores it.
    client.notify('initialized', {});
  }

  async startThread(opts: {
    cwd: string;
    model?: string;
    sandbox?: CodexSandbox;
  }): Promise<{ threadId: string }> {
    // Note: effort is intentionally never sent on thread/start — it belongs on turn/start.
    const result = await this.require().request<{ thread: CodexThread }>('thread/start', {
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.sandbox ? { sandbox: toThreadSandbox(opts.sandbox) } : {}),
    });
    return { threadId: result.thread.id };
  }

  async resumeThread(
    threadId: string,
    opts?: { model?: string; sandbox?: CodexSandbox },
  ): Promise<{ threadId: string }> {
    const result = await this.require().request<{ thread: CodexThread }>('thread/resume', {
      threadId,
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.sandbox ? { sandbox: toThreadSandbox(opts.sandbox) } : {}),
    });
    return { threadId: result.thread.id };
  }

  startTurn(
    threadId: string,
    input: CodexInput[],
    handlers: CodexTurnHandlers,
    opts?: StartTurnOptions,
  ): Promise<CodexTurnResult> {
    const client = this.require();
    const clientUserMessageId = randomUUID();

    return new Promise<CodexTurnResult>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        settled = true;
        this.activeTurns.delete(threadId);
        if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
      };

      const active: ActiveTurn = {
        threadId,
        handlers,
        usage: {},
        interruptRequested: false,
        settle: (result) => {
          if (settled) return;
          finish();
          resolve(result);
        },
        fail: (err) => {
          if (settled) return;
          finish();
          reject(err);
        },
      };

      const onAbort = () => {
        // Don't reject on abort — interrupt and let the server's turn/completed (status:interrupted)
        // settle the promise with a clean CodexTurnResult the caller can still inspect.
        if (active.turnId) {
          void this.interrupt(threadId, active.turnId);
        } else {
          active.interruptRequested = true;
        }
      };

      if (opts?.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.activeTurns.set(threadId, active);

      client
        .request<{ turn?: { id?: string } }>('turn/start', {
          threadId,
          clientUserMessageId,
          input,
          ...(opts?.model ? { model: opts.model } : {}),
          // effort is passed through verbatim — never clamped or downgraded.
          ...(opts?.effort ? { effort: opts.effort } : {}),
          ...(opts?.sandbox ? { sandboxPolicy: toTurnSandboxPolicy(opts.sandbox) } : {}),
        })
        .then((result) => {
          // The response confirms acceptance and carries the turn id; turn/started confirms it too.
          const id = result?.turn?.id;
          if (id && !active.turnId) {
            active.turnId = id;
            if (active.interruptRequested) void this.interrupt(threadId, id);
          }
        })
        .catch((err) => active.fail(err instanceof Error ? err : new Error(String(err))));
    });
  }

  async steer(threadId: string, turnId: string, input: CodexInput[]): Promise<void> {
    await this.require().request('turn/steer', {
      threadId,
      clientUserMessageId: randomUUID(),
      input,
      expectedTurnId: turnId,
    });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.require().request('turn/interrupt', { threadId, turnId });
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  readAuthHome(): string | null {
    try {
      return readFileSync(join(this.codexHome, 'auth.json'), 'utf8');
    } catch {
      return null;
    }
  }

  private require(): AppServerClient {
    if (!this.client) throw new Error('CodexClient not initialized — call init() first');
    return this.client;
  }

  private registerApprovalHandlers(client: AppServerClient): void {
    for (const [method, kind] of Object.entries(APPROVAL_METHODS)) {
      client.onServerRequest(method, async (params) => {
        const p = asRecord(params);
        const req: CodexApprovalRequest = {
          kind,
          threadId: str(p.threadId),
          turnId: str(p.turnId),
          itemId: str(p.itemId),
          raw: params,
        };
        const active = this.activeTurns.get(req.threadId);
        const decision = (await active?.handlers.onApproval?.(req)) ?? 'accept';
        return { decision };
      });
    }
  }

  private registerNotificationHandlers(client: AppServerClient): void {
    for (const method of NOTIFICATION_METHODS) {
      client.onNotification(method, (params) => this.dispatchNotification(method, params));
    }
  }

  private dispatchNotification(method: string, params: unknown): void {
    const event = mapNotification(method, params);
    const active = this.resolveActive(event);
    if (!active) return;

    if (event.type === 'turnStarted') {
      active.turnId = event.turnId;
      if (active.interruptRequested) void this.interrupt(active.threadId, event.turnId);
    } else if (event.type === 'tokenUsageUpdated') {
      // `tokenUsage.total` on the wire is already the server-accumulated cumulative snapshot for
      // this turn — no manual field-by-field merge needed, just take the latest snapshot verbatim.
      active.usage = event.usage;
    }

    active.handlers.onEvent(event);

    if (event.type === 'turnCompleted') {
      active.settle({
        threadId: event.threadId,
        turnId: event.turnId,
        status: event.status,
        usage: event.usage ?? (hasUsage(active.usage) ? active.usage : undefined),
        error: event.error,
        authHomePath: this.codexHome,
      });
    }
  }

  private resolveActive(event: CodexEvent): ActiveTurn | undefined {
    const threadId = 'threadId' in event ? event.threadId : undefined;
    if (threadId) {
      const byThread = this.activeTurns.get(threadId);
      if (byThread) return byThread;
    }
    // Events without a usable threadId (e.g. 'unknown') route to the sole active turn when there is
    // exactly one, so nothing is dropped under this SDK's single-turn model.
    if (this.activeTurns.size === 1) return this.activeTurns.values().next().value;
    return undefined;
  }
}

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' ? (value as AnyRecord) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function turnStatus(value: unknown): CodexTurnStatus {
  return TURN_STATUSES.includes(value as CodexTurnStatus) ? (value as CodexTurnStatus) : 'completed';
}

function parseUsage(value: unknown): CodexTokenUsage | undefined {
  const r = asRecord(value);
  const usage: CodexTokenUsage = {
    inputTokens: num(r.inputTokens),
    cachedInputTokens: num(r.cachedInputTokens),
    outputTokens: num(r.outputTokens),
    reasoningOutputTokens: num(r.reasoningOutputTokens),
    totalTokens: num(r.totalTokens),
  };
  return hasUsage(usage) ? usage : undefined;
}

function hasUsage(usage: CodexTokenUsage): boolean {
  return Object.values(usage).some((v) => v !== undefined);
}

function parseError(value: unknown): CodexTurnError | undefined {
  const r = asRecord(value);
  if (typeof r.message === 'string') return { message: r.message };
  return undefined;
}

function mapNotification(method: string, params: unknown): CodexEvent {
  const p = asRecord(params);
  switch (method) {
    case 'turn/started':
      return {
        type: 'turnStarted',
        threadId: str(p.threadId),
        turnId: str(asRecord(p.turn).id),
        raw: params,
      };
    case 'turn/completed': {
      const turn = asRecord(p.turn);
      return {
        type: 'turnCompleted',
        threadId: str(p.threadId),
        turnId: str(turn.id),
        status: turnStatus(turn.status),
        usage: parseUsage(turn.usage),
        error: parseError(turn.error),
        raw: params,
      };
    }
    case 'item/started':
      return {
        type: 'itemStarted',
        threadId: str(p.threadId),
        turnId: str(p.turnId),
        item: asItem(p.item),
        raw: params,
      };
    case 'item/completed':
      return {
        type: 'itemCompleted',
        threadId: str(p.threadId),
        turnId: str(p.turnId),
        item: asItem(p.item),
        raw: params,
      };
    case 'item/agentMessage/delta':
      return {
        type: 'agentMessageDelta',
        threadId: str(p.threadId),
        turnId: str(p.turnId),
        itemId: str(p.itemId),
        delta: str(p.delta),
        raw: params,
      };
    case 'item/reasoning/summaryTextDelta':
      return {
        type: 'reasoningSummaryTextDelta',
        threadId: str(p.threadId),
        turnId: str(p.turnId),
        itemId: str(p.itemId),
        delta: str(p.delta),
        raw: params,
      };
    case 'item/reasoning/textDelta':
      return {
        type: 'reasoningTextDelta',
        threadId: str(p.threadId),
        turnId: str(p.turnId),
        itemId: str(p.itemId),
        delta: str(p.delta),
        raw: params,
      };
    case 'item/commandExecution/outputDelta':
      return {
        type: 'commandExecutionOutputDelta',
        threadId: str(p.threadId),
        turnId: str(p.turnId),
        itemId: str(p.itemId),
        // The wire uses `delta`, but older builds used `chunk` — accept either.
        delta: str(p.delta ?? p.chunk),
        raw: params,
      };
    case 'item/fileChange/patchUpdated':
      return {
        type: 'fileChangePatchUpdated',
        threadId: str(p.threadId),
        turnId: str(p.turnId),
        itemId: str(p.itemId),
        raw: params,
      };
    case 'turn/diff/updated':
      return { type: 'turnDiffUpdated', threadId: str(p.threadId), turnId: str(p.turnId), raw: params };
    case 'thread/tokenUsage/updated':
      return {
        type: 'tokenUsageUpdated',
        threadId: str(p.threadId),
        turnId: str(p.turnId),
        usage: parseUsage(asRecord(p.tokenUsage).total) ?? {},
        raw: params,
      };
    default:
      return { type: 'unknown', method, raw: params };
  }
}

function asItem(value: unknown): CodexItem {
  const r = asRecord(value);
  return { ...r, id: str(r.id), type: str(r.type) };
}
