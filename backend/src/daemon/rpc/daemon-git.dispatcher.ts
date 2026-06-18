import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  replyStream,
  type GitCommand,
  type GitReplyFrame,
} from '@harness/workspaces/daemon-protocol';
import {
  REDIS_STREAM_PORT,
  type RedisStreamPort,
} from '../../_lib/redis/redis.port';
import { DaemonGitService } from '../git/daemon-git.service';

/**
 * Invokes ONE `DaemonGitService` public method from a 'git' command and writes the single typed reply
 * to `reply:{correlationId}`. This is how the host's `WorkspaceGitPort` (Phase 8) reaches the daemon's
 * git surface (clone/worktree/shared/publish/PR) — every host git call becomes one of these RPCs.
 *
 * The method name comes off the wire, so it's validated against an explicit ALLOWLIST of the git
 * service's RPC-exposed methods — never a blind `service[method]` (which would let a malformed/hostile
 * command call an arbitrary property). An unknown method replies with an error frame, not a throw.
 */
@Injectable()
export class DaemonGitDispatcher {
  private readonly logger = new Logger(DaemonGitDispatcher.name);

  constructor(
    private readonly git: DaemonGitService,
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
  ) {}

  async handleGit(cmd: GitCommand): Promise<void> {
    const { correlationId, payload } = cmd;
    const reply = replyStream(correlationId);
    let frame: GitReplyFrame;
    try {
      if (!GIT_RPC_METHODS.has(payload.method)) {
        throw new Error(`unknown git RPC method '${payload.method}'`);
      }
      const fn = this.git[payload.method as GitRpcMethod] as (
        ...args: unknown[]
      ) => unknown;
      const value = await Promise.resolve(
        fn.apply(this.git, payload.args ?? []),
      );
      frame = { ok: true, value: value ?? null };
      this.logger.debug(`git ${correlationId}: ${payload.method} ok`);
    } catch (err) {
      frame = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      this.logger.warn(
        `git ${correlationId}: ${payload.method} failed — ${frame.error}`,
      );
    }
    await this.redis
      .xadd(reply, frame)
      .catch((e) =>
        this.logger.error(
          `git ${correlationId}: reply XADD failed: ${String(e)}`,
        ),
      );
  }
}

/**
 * The `DaemonGitService` methods exposed over the git RPC (its public surface — Phase 4). Listed
 * explicitly so a wire `method` can't reach a private member or a prototype property. `keyof`-typed so
 * a rename of a git method surfaces as a compile error here, not a silent missing-RPC at run time.
 */
type GitRpcMethod = Extract<
  keyof DaemonGitService,
  | 'ensureClone'
  | 'createWorktree'
  | 'listWorktrees'
  | 'removeWorktree'
  | 'worktreePath'
  | 'refreshFromBase'
  | 'mergeState'
  | 'sharedBranchName'
  | 'ensureShared'
  | 'ensureSharedAtBase'
  | 'sharedRef'
  | 'ownerDiff'
  | 'sharedStatus'
  | 'reviewRange'
  | 'publish'
  | 'pull'
  | 'pushSharedToOrigin'
  | 'openPr'
  | 'markReady'
  | 'commentPr'
  | 'attachDesign'
  | 'ensureReferenceClone'
  | 'referenceOrientation'
>;

const GIT_RPC_METHODS: ReadonlySet<string> = new Set<GitRpcMethod>([
  'ensureClone',
  'createWorktree',
  'listWorktrees',
  'removeWorktree',
  'worktreePath',
  'refreshFromBase',
  'mergeState',
  'sharedBranchName',
  'ensureShared',
  'ensureSharedAtBase',
  'sharedRef',
  'ownerDiff',
  'sharedStatus',
  'reviewRange',
  'publish',
  'pull',
  'pushSharedToOrigin',
  'openPr',
  'markReady',
  'commentPr',
  'attachDesign',
  'ensureReferenceClone',
  'referenceOrientation',
]);
