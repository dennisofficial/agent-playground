import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { reapLiveProcessGroups } from '@harness/engines/process-group';
import { DaemonGitService } from '../git/daemon-git.service';

const execFileAsync = promisify(execFile);

/** How long to give a `docker compose down` per worktree before moving on (the container is going away
 * regardless — this is graceful teardown, not a guarantee). */
const COMPOSE_DOWN_TIMEOUT_MS = 30_000;

/**
 * Daemon shutdown hardening (Phase 10) — best-effort cleanup when the sandbox daemon stops (SIGTERM
 * from `docker stop`, or a clean Nest shutdown). The sandbox is DISPOSABLE, so none of this is required
 * for correctness; it's hygiene that keeps a long-lived host from accreting orphaned dev servers and
 * inner-Docker stacks when sandboxes are reused/restarted rather than destroyed.
 *
 * On shutdown it, in order:
 *  1) REAPS lingering engine process groups (the `pnpm dev &` / `next dev` an execute turn backgrounded
 *     — see process-group.ts). A single group-kill per turn's leader takes its whole subtree.
 *  2) TEARS DOWN inner-Docker compose stacks the agent started under each session's worktree
 *     (`docker compose down` per worktree dir, best-effort) — the very `docker compose up` this whole
 *     feature exists to make private to the sandbox. Skipped entirely when the inner Docker isn't
 *     reachable (nothing could have been started).
 *  3) Leaves stopping `dockerd` itself to the container ENTRYPOINT's signal trap (it owns dockerd's
 *     lifecycle); we only down the stacks we know about from the worktree set.
 *
 * Every step is wrapped so one failure never blocks the next or the process exit. Ordered BEFORE the
 * container's own teardown so compose stacks come down while dockerd is still up.
 */
@Injectable()
export class DaemonShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(DaemonShutdownService.name);

  constructor(private readonly git: DaemonGitService) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`shutdown (${signal ?? 'unknown'}) — best-effort cleanup`);
    // 1) Reap backgrounded dev servers from engine turns.
    try {
      reapLiveProcessGroups('SIGTERM');
    } catch (err) {
      this.logger.warn(`process-group reap failed: ${String(err)}`);
    }
    // 2) Bring down any inner-Docker compose stacks the agent started.
    await this.teardownInnerStacks();
  }

  /** `docker compose down` in every known session worktree, best-effort. Only attempted when the inner
   * Docker daemon is actually reachable (a sandbox that never ran one has nothing to tear down). */
  private async teardownInnerStacks(): Promise<void> {
    if (!(await this.innerDockerReachable())) {
      this.logger.log('inner Docker not reachable — no compose stacks to tear down');
      return;
    }
    const worktrees = this.git.listWorktrees();
    if (worktrees.length === 0) return;
    this.logger.log(
      `tearing down inner compose stacks under ${worktrees.length} worktree(s)`,
    );
    // Sequential, isolated failures: one worktree without a compose file (the common case) must not
    // abort the rest. `docker compose down` is a no-op + nonzero-exit when there's no project, which we
    // swallow.
    for (const wt of worktrees) {
      try {
        await execFileAsync(
          'docker',
          ['compose', 'down', '--remove-orphans', '--volumes'],
          { cwd: wt.path, timeout: COMPOSE_DOWN_TIMEOUT_MS },
        );
        this.logger.log(`compose down ok in ${wt.path}`);
      } catch {
        // No compose project here (or it's already down) — expected for most worktrees; stay quiet.
      }
    }
  }

  /** `docker info` succeeds ⇒ the inner Docker daemon is up. Quiet + fast (short timeout). */
  private async innerDockerReachable(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['info'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}
