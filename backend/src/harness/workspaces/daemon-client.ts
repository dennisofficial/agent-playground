import { Inject, Injectable, Logger } from '@nestjs/common';
import type { WorkerEvent } from '@harness/engines/worker-engine.port';
import {
  abortChannel,
  cmdStream,
  eventStream,
  newCorrelationId,
  replyStream,
  type DaemonCommand,
  type GitCommandPayload,
  type GitReplyFrame,
  type RunCommandPayload,
  type RunFrame,
  type RunResult,
} from './daemon-protocol';
import {
  REDIS_STREAM_PORT,
  type RedisStreamPort,
} from '../../_lib/redis/redis.port';

/** Event-tail block window — each blocking XREAD waits this long, then loops (re-checks resolution). */
const EVENT_BLOCK_MS = 5000;
/** Git-reply block window. */
const REPLY_BLOCK_MS = 5000;
/** How long to wait for a git reply before giving up (a daemon that never answers must not hang forever). */
const GIT_REPLY_TIMEOUT_MS = 120_000;

/**
 * The HOST's client to a sandbox daemon over Redis (Phase 5) — the producer/consumer counterpart to
 * the daemon's consumer loop + dispatchers. The Phase-7 `RemoteTurnDispatcher` and Phase-8
 * `DaemonGitAdapter` call THIS; it never knows about sessions/workspaces beyond the ids it's handed.
 *
 *  - `dispatchRun` — XADD a 'run' command, bridge the caller's `AbortSignal` to a PUBLISH on the abort
 *    channel, then TAIL the per-run event stream: each `{kind:'event'}` → `onEvent`, terminal
 *    `{kind:'result'}` resolves, `{kind:'error'}` rejects. The tail RESUMES from the last seen id
 *    after each (possibly empty) blocking read, so a transient read returning [] just loops without
 *    losing or re-reading events — the events are durable on the stream.
 *  - `gitCall` — XADD a 'git' command and await the SINGLE reply frame, returning `value` or throwing.
 */
@Injectable()
export class DaemonClient {
  private readonly logger = new Logger(DaemonClient.name);

  constructor(
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
  ) {}

  /**
   * Dispatch one engine turn to the workspace's daemon and stream its events back, resolving with the
   * same `{result, sessionId?, questions?, planText?, usage?}` shape `WorkerEngine.run()` returns.
   */
  async dispatchRun(
    workspaceId: string,
    payload: RunCommandPayload,
    onEvent: (e: WorkerEvent) => void,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const correlationId = newCorrelationId();
    const events = eventStream(correlationId);

    // Bridge the caller's signal → an abort PUBLISH the daemon's run subscription consumes. If the
    // signal is ALREADY aborted, publish immediately (the daemon aborts as soon as it subscribes).
    let detachAbort: (() => void) | undefined;
    if (signal) {
      const fire = (): void => {
        void this.redis
          .publish(abortChannel(correlationId), { abort: true })
          .catch((err) =>
            this.logger.warn(
              `run ${correlationId}: abort publish failed: ${String(err)}`,
            ),
          );
      };
      if (signal.aborted) fire();
      else {
        signal.addEventListener('abort', fire, { once: true });
        detachAbort = () => signal.removeEventListener('abort', fire);
      }
    }

    try {
      // Enqueue the command. (XADD before tailing is fine — events are durable; the daemon's frames
      // wait on the stream until we read them, so there's no race where we miss early events.)
      await this.publishCommand(workspaceId, {
        type: 'run',
        correlationId,
        payload,
      });

      // Tail the event stream from the start, resuming past the last id each loop.
      let lastId = '0';
      for (;;) {
        const entries = await this.redis.xread({
          stream: events,
          lastId,
          count: 64,
          blockMs: EVENT_BLOCK_MS,
        });
        if (entries.length === 0) {
          // BLOCK timeout with nothing new — loop and keep tailing from the same lastId (resume).
          continue;
        }
        for (const entry of entries) {
          lastId = entry.id;
          const frame = entry.data as RunFrame;
          if (frame.kind === 'event') {
            onEvent(frame.event);
          } else if (frame.kind === 'result') {
            return {
              result: frame.result,
              sessionId: frame.sessionId,
              questions: frame.questions,
              planText: frame.planText,
              usage: frame.usage,
            };
          } else if (frame.kind === 'error') {
            throw new Error(`daemon run failed: ${frame.message}`);
          }
        }
      }
    } finally {
      detachAbort?.();
    }
  }

  /**
   * Invoke one `DaemonGitService` method on the workspace's daemon and return its result. The daemon
   * writes a single reply frame to `reply:{cid}`; we tail it (resuming) until it arrives or we time out.
   */
  async gitCall(
    workspaceId: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const correlationId = newCorrelationId();
    const reply = replyStream(correlationId);
    const payload: GitCommandPayload = { method, args };

    await this.publishCommand(workspaceId, {
      type: 'git',
      correlationId,
      payload,
    });

    const deadline = Date.now() + GIT_REPLY_TIMEOUT_MS;
    let lastId = '0';
    for (;;) {
      if (Date.now() >= deadline) {
        throw new Error(
          `git RPC '${method}' timed out after ${GIT_REPLY_TIMEOUT_MS}ms (workspace ${workspaceId})`,
        );
      }
      const entries = await this.redis.xread({
        stream: reply,
        lastId,
        count: 1,
        blockMs: REPLY_BLOCK_MS,
      });
      if (entries.length === 0) continue; // timeout — loop until the deadline.
      const frame = entries[0].data as GitReplyFrame;
      if (frame.ok) return frame.value;
      throw new Error(`daemon git '${method}' failed: ${frame.error}`);
    }
  }

  /** XADD a command onto the workspace's command stream. */
  private async publishCommand(
    workspaceId: string,
    cmd: DaemonCommand,
  ): Promise<void> {
    await this.redis.xadd(cmdStream(workspaceId), cmd);
  }
}
