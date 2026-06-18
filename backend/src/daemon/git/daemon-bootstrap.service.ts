import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { DaemonGitService } from './daemon-git.service';

/**
 * The daemon's CLONE-ON-BOOT step (Phase 11 bootstrap-wiring).
 *
 * `DaemonGitService.ensureClone` is the explicit entry point that materializes the sandbox's single
 * fresh clone — but until now NOTHING called it at run time (only the specs did), so a real sandbox's
 * first turn hit `createWorktree` → `requireRepo()` → "No clone yet". This service closes that gap: on
 * application bootstrap, when running as a real sandbox daemon (`WORKSPACE_ID` set) and given the repo
 * coordinates the host injects (`WORKSPACE_REPO_URL` / `WORKSPACE_BASE_BRANCH`), it clones the repo into
 * `WORKSPACE_ROOT` via the existing `GitCredentialProvider` BEFORE any turn runs.
 *
 * Readiness interplay: it ARMS the clone gate (`git.expectClone()`) synchronously here — before the
 * fire-and-forget clone starts — so `DaemonReadinessService.signalWhenReady` (which `await`s
 * `git.whenCloned()`) cannot write the ready marker until the clone has finished. On success it settles
 * the gate (`markCloned`); on failure it settles it as failed (`markCloneFailed`) so readiness signals
 * loudly WITHOUT a clone rather than the host dispatching a turn against a missing repo.
 *
 * Env is read directly from `process.env` (same pattern as `WORKSPACE_ID` in the consumer loop and the
 * GIT_* keys in `EnvGitCredentialProvider`): the daemon binds the host `EnvService` typed over the host
 * `IEnvConfig`, which doesn't carry the WORKSPACE_REPO_* keys; they validate through the daemon's
 * `.unknown(true)` schema (declared in `IDaemonEnvConfig` for documentation).
 *
 * Flag-off-safe: with no `WORKSPACE_ID` (a dev/standalone/unit boot) it does nothing and never arms the
 * gate — the readiness path resolves immediately and behavior is unchanged. With `WORKSPACE_ID` but no
 * `WORKSPACE_REPO_URL`, it logs loudly and skips (a sandbox with no repo coordinates is a host
 * misconfiguration, not a daemon crash).
 */
@Injectable()
export class DaemonBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DaemonBootstrapService.name);

  constructor(private readonly git: DaemonGitService) {}

  onApplicationBootstrap(): void {
    const workspaceId = process.env.WORKSPACE_ID?.trim();
    if (!workspaceId) {
      // Not a real sandbox (dev/standalone/unit boot) — no host-injected repo to clone; leave the
      // clone gate unarmed so readiness resolves immediately.
      this.logger.debug(
        'WORKSPACE_ID unset — skipping clone-on-boot (standalone/dev daemon).',
      );
      return;
    }

    const repoUrl = process.env.WORKSPACE_REPO_URL?.trim();
    const baseBranch =
      process.env.WORKSPACE_BASE_BRANCH?.trim() || 'main';
    const workspaceRoot =
      process.env.WORKSPACE_ROOT?.trim() || '/workspace/repo';

    if (!repoUrl) {
      // A real sandbox with no repo coordinates is a host misconfiguration. Don't arm the gate (so a
      // non-git turn could still run) but warn loudly — the first turn's worktree op will fail clearly.
      this.logger.error(
        `WORKSPACE_REPO_URL unset for sandbox ${workspaceId} — NO clone-on-boot; the first turn's ` +
          `git op will fail with "No clone yet". (Host ContainerManager must inject WORKSPACE_REPO_URL.)`,
      );
      return;
    }

    // Arm the gate SYNCHRONOUSLY (before the async clone) so readiness can't race past it.
    this.git.expectClone();

    void this.cloneOnBoot(workspaceRoot, repoUrl, baseBranch).then(
      () => this.git.markCloned(),
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error(
          `clone-on-boot FAILED for ${repoUrl} (base ${baseBranch}) → ${workspaceRoot}: ${error.message}`,
        );
        this.git.markCloneFailed(error);
      },
    );
  }

  private async cloneOnBoot(
    workspaceRoot: string,
    repoUrl: string,
    baseBranch: string,
  ): Promise<void> {
    this.logger.log(
      `clone-on-boot: ${repoUrl} (base ${baseBranch}) → ${workspaceRoot}`,
    );
    const root = await this.git.ensureClone(workspaceRoot, repoUrl, baseBranch);
    this.logger.log(`clone-on-boot complete — repo ready at ${root}`);
  }
}
