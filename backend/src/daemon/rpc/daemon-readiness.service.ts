import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { readyKey, type ReadyFrame } from '@harness/workspaces/daemon-protocol';
import {
  REDIS_STREAM_PORT,
  type RedisStreamPort,
} from '../../_lib/redis/redis.port';
import { DaemonGitService } from '../git/daemon-git.service';

const execFileAsync = promisify(execFile);

/** Poll cadence + ceiling for the inner-Docker wait. dockerd in a fresh privileged container is up in
 * a few seconds; the ceiling is generous so a slow first boot (storage-driver init on a new volume)
 * still readies rather than wedging — but it is BOUNDED so a genuinely broken dockerd surfaces as a
 * "signaled WITHOUT inner Docker" warning instead of hanging boot forever. */
const DOCKER_POLL_MS = 1_000;
const DOCKER_READY_TIMEOUT_MS = 120_000;

/**
 * The daemon's READINESS GATE (Phase 10).
 *
 * The host must not dispatch a turn that needs `docker compose up` before the sandbox's INNER Docker is
 * reachable — so the daemon waits for `docker info` to succeed, THEN writes a durable ready marker to
 * `ws:{WORKSPACE_ID}:ready`. Readiness here means: the DI graph is up (this hook running proves engines
 * + tools provider resolved) AND, when inner Docker is expected, `dockerd` answers.
 *
 * Inner Docker is "expected" when running as a real privileged sandbox — keyed on the same relaxed
 * posture flag the engines use (`SANDBOX_GUARD_RELAXED`, set in the image alongside the dockerd
 * entrypoint). A dev/standalone daemon (no WORKSPACE_ID, or no inner Docker) skips the wait and either
 * signals immediately or doesn't signal at all (no host to consume the marker).
 *
 * Resilience mirrors the consumer loop: the marker XADD is best-effort behind a lazy Redis client, so a
 * transient Redis absence never crashes boot — the host's own readiness probe (Phase 6/11) re-checks.
 */
@Injectable()
export class DaemonReadinessService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DaemonReadinessService.name);

  constructor(
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
    private readonly git: DaemonGitService,
  ) {}

  onApplicationBootstrap(): void {
    // Fire-and-forget — readiness signaling must not block the bootstrap of the rest of the graph (the
    // consumer loop starts in parallel; a turn that arrives before the marker simply waits on the host
    // side). Errors are contained.
    void this.signalWhenReady().catch((err) =>
      this.logger.error(`readiness signaling failed: ${String(err)}`),
    );
  }

  private async signalWhenReady(): Promise<void> {
    const workspaceId = process.env.WORKSPACE_ID?.trim();
    if (!workspaceId) {
      // Not a real sandbox (e.g. a unit boot) — nobody consumes the marker; skip silently.
      this.logger.warn(
        'WORKSPACE_ID unset — readiness marker NOT written (standalone/dev daemon).',
      );
      return;
    }

    // Gate readiness on the boot CLONE (Phase 11): the host must not dispatch a turn before the
    // sandbox's fresh clone exists, or the turn's first `createWorktree` throws "No clone yet".
    // `whenCloned()` resolves immediately when no clone is expected (the gate was never armed —
    // dev/standalone or a fixture), and otherwise settles when `DaemonBootstrapService` finishes the
    // clone. A FAILED clone rejects here — we still signal (below) so a non-git turn can run and the
    // failure is loud, rather than wedging boot.
    try {
      await this.git.whenCloned();
      this.logger.log('boot clone ready (or none expected) — proceeding to readiness');
    } catch (err) {
      this.logger.error(
        `boot clone failed (${err instanceof Error ? err.message : String(err)}) — ` +
          `signaling ready anyway; git turns will fail until a clone exists`,
      );
    }

    let innerDocker = false;
    if (this.innerDockerExpected()) {
      innerDocker = await this.waitForInnerDocker();
      if (!innerDocker) {
        // Signal ANYWAY (bounded) so a broken-dockerd sandbox can still run non-Docker turns rather
        // than wedging boot — but loudly, with innerDocker:false on the marker so the host knows
        // `docker compose` turns may fail here.
        this.logger.error(
          `inner Docker did not become reachable within ${DOCKER_READY_TIMEOUT_MS}ms — signaling ready WITHOUT it`,
        );
      }
    }

    const frame: ReadyFrame = { ready: true, innerDocker, at: Date.now() };
    await this.redis
      .xadd(readyKey(workspaceId), frame)
      .then(() =>
        this.logger.log(
          `readiness marker written (innerDocker=${innerDocker}) → ${readyKey(workspaceId)}`,
        ),
      )
      .catch((err) =>
        this.logger.warn(`readiness XADD failed (host re-probes): ${String(err)}`),
      );
  }

  /** Inner Docker is expected in the privileged sandbox posture (same flag the engines relax under). */
  private innerDockerExpected(): boolean {
    return (
      (process.env.SANDBOX_GUARD_RELAXED ?? '').trim().toLowerCase() === 'true'
    );
  }

  /** Poll `docker info` until it succeeds or the ceiling is hit. Returns true once dockerd answers. */
  private async waitForInnerDocker(): Promise<boolean> {
    const deadline = Date.now() + DOCKER_READY_TIMEOUT_MS;
    this.logger.log('waiting for inner Docker (docker info)…');
    while (Date.now() < deadline) {
      if (await this.dockerInfoOk()) {
        this.logger.log('inner Docker is reachable');
        return true;
      }
      await sleep(DOCKER_POLL_MS);
    }
    return false;
  }

  private async dockerInfoOk(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['info'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}
