import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { EnvService } from '@core/config/env/env.service';
import {
  cmdStream,
  DAEMON_CONSUMER_GROUP,
  type DaemonCommand,
  type GitCommand,
  type RunCommand,
} from '@harness/workspaces/daemon-protocol';
import {
  REDIS_STREAM_PORT,
  type RedisStreamPort,
  type StreamEntry,
} from '../../_lib/redis/redis.port';
import { DaemonGitDispatcher } from './daemon-git.dispatcher';
import { DaemonTurnService } from './daemon-turn.service';

/** How long each blocking group read waits before looping (re-checks the stop flag, retries on error). */
const BLOCK_MS = 5000;

/**
 * The daemon's command CONSUMER LOOP — the entry point that gives the daemon work (Phase 5).
 *
 * On bootstrap it (idempotently) creates the `daemon` consumer group on this sandbox's own command
 * stream `ws:{WORKSPACE_ID}:cmds`, then XREADGROUP-loops, dispatching each command by type:
 *   'run' → `DaemonTurnService.handleRun`   (an engine turn)
 *   'git' → `DaemonGitDispatcher.handleGit` (one git RPC)
 *
 * RESILIENCE is the contract: if Redis is down the loop CATCHES the read error, backs off, and retries
 * — it never crashes boot (the daemon's `createApplicationContext` comes up with Redis absent and this
 * loop simply keeps retrying until Redis appears). `WORKSPACE_ID` is the sandbox's own id, injected at
 * container creation; the daemon consumes only its own stream.
 *
 * Commands are dispatched WITHOUT awaiting completion (a long engine turn must not block the next git
 * RPC or abort), and each is acked as soon as it's dispatched (at-least-once; a crashed turn surfaces
 * as a missing terminal frame the host times out on, not a redelivery storm).
 */
@Injectable()
export class DaemonCommandConsumer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(DaemonCommandConsumer.name);
  private readonly consumerName = `daemon-${process.pid}`;
  private stopped = false;
  private loop?: Promise<void>;
  private groupReady = false;

  constructor(
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
    private readonly env: EnvService,
    private readonly turns: DaemonTurnService,
    private readonly gitDispatcher: DaemonGitDispatcher,
  ) {}

  onApplicationBootstrap(): void {
    const workspaceId = this.workspaceId();
    if (!workspaceId) {
      // No WORKSPACE_ID → not running as a sandbox daemon (e.g. a unit boot). Don't start the loop.
      this.logger.warn(
        'WORKSPACE_ID unset — command consumer loop NOT started (standalone/dev daemon).',
      );
      return;
    }
    const stream = cmdStream(workspaceId);
    this.logger.log(`consuming ${stream} as group '${DAEMON_CONSUMER_GROUP}'`);
    // Fire-and-forget — the loop owns its own lifetime + error handling.
    this.loop = this.run(stream).catch((err) =>
      this.logger.error(`consumer loop exited unexpectedly: ${String(err)}`),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    // The in-flight blocking read returns within BLOCK_MS; await the loop's clean exit.
    await this.loop?.catch(() => undefined);
  }

  private async run(stream: string): Promise<void> {
    while (!this.stopped) {
      try {
        if (!this.groupReady) {
          await this.redis.ensureGroup(stream, DAEMON_CONSUMER_GROUP);
          this.groupReady = true;
        }
        const entries = await this.redis.xreadGroup({
          group: DAEMON_CONSUMER_GROUP,
          consumer: this.consumerName,
          stream,
          count: 16,
          blockMs: BLOCK_MS,
        });
        if (entries.length === 0) continue; // BLOCK timeout — loop, re-check stop flag.
        // Ack immediately (at-least-once); dispatch without awaiting so turns/git RPCs run concurrently.
        await this.redis.ack(
          stream,
          DAEMON_CONSUMER_GROUP,
          entries.map((e) => e.id),
        );
        for (const entry of entries) this.dispatch(entry);
      } catch (err) {
        // Redis down / read error — DO NOT crash. Reset the group flag (a new connection may need it
        // re-created) and back off briefly before retrying.
        this.groupReady = false;
        if (!this.stopped) {
          this.logger.warn(
            `consumer read failed (will retry): ${String(err)}`,
          );
          await sleep(1000);
        }
      }
    }
    this.logger.log('consumer loop stopped');
  }

  /** Route one command to its handler. Malformed frames are logged and dropped (already acked). */
  private dispatch(entry: StreamEntry): void {
    const cmd = entry.data as DaemonCommand;
    if (!cmd || typeof cmd.type !== 'string' || !cmd.correlationId) {
      this.logger.warn(`dropping malformed command entry ${entry.id}`);
      return;
    }
    switch (cmd.type) {
      case 'run':
        void this.turns
          .handleRun(cmd as RunCommand)
          .catch((err) =>
            this.logger.error(`run ${cmd.correlationId} threw: ${String(err)}`),
          );
        return;
      case 'git':
        void this.gitDispatcher
          .handleGit(cmd as GitCommand)
          .catch((err) =>
            this.logger.error(`git ${cmd.correlationId} threw: ${String(err)}`),
          );
        return;
      default:
        this.logger.warn(
          `unknown command type '${String(cmd.type)}' (${cmd.correlationId})`,
        );
    }
  }

  /** The sandbox's own id, injected at container creation. Read directly from process.env (the daemon
   * binds the host EnvService, whose IEnvConfig doesn't carry WORKSPACE_ID — same pattern the git
   * credential vars use). */
  private workspaceId(): string | undefined {
    return process.env.WORKSPACE_ID?.trim() || undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}
