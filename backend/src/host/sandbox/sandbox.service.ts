import { EnvService } from '@core/config/env/env.service';
import { type V1Container, type V1Pod, type V1VolumeMount } from '@kubernetes/client-node';
import { Job } from '@lib/database/entities/job.entity';
import { K8sService, TerminalPodError } from '@lib/k8s/k8s.service';
import { isK8sConflictError } from '@lib/k8s/k8s.util';
import { REDIS_CLIENT } from '@lib/redis/redis.tokens';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ATLAS_STATE_MOUNT,
  ATLAS_STATE_VOLUME,
  DOCKER_STORAGE_MOUNT,
  DOCKER_STORAGE_VOLUME,
  WORK_MOUNT,
  WORK_VOLUME,
} from '@shared/engine/paths.constants';
import { Db } from '@workspace/nestjs-rls/nest';
import type { Redis } from 'ioredis';
import { resolve } from 'node:path';
import { ProvisionStatusService } from '../provision-status/provision-status.service';
import {
  type WorkspaceMountView,
  WorkspaceProfileService,
} from '../workspace-profile/workspace-profile.service';
import {
  ENGINE_ENTRYPOINT,
  LABEL_JOB,
  LABEL_ORG,
  LEASE_TTL_S,
  MAIN_CONTAINER,
  POD_NAME_PREFIX,
  POD_RESOURCES,
  SETUP_CONTAINER,
  SHELL_PREFIX_WRAPPER,
} from './sandbox.constants';

@Injectable()
export class SandboxService {
  private readonly logger = new Logger(this.constructor.name);
  private readonly _namespace: string = 'atlas-sandboxes';
  private readonly _image: string;
  private readonly _sandboxRedisUrl: string;
  private readonly _atlasData: string;
  private readonly isTestDb: boolean;

  constructor(
    private readonly db: Db,
    private readonly profile: WorkspaceProfileService,
    private readonly status: ProvisionStatusService,
    private readonly k8s: K8sService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    env: EnvService,
  ) {
    this._image = env.get('SANDBOX_IMAGE');
    this._sandboxRedisUrl = env.get('SANDBOX_REDIS_URL');
    this._atlasData = resolve(env.get('ATLAS_DATA'));
    this.isTestDb = /_test$/.test(env.get('POSTGRES_DB'));
  }

  async ensureReady(jobId: string): Promise<void> {
    const job = await this.db.unsafe(Job).findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);

    await this.touch(jobId);

    const name = SandboxService.podName(jobId);
    const existing = await this.k8s.getPod(this._namespace, name);
    if (existing) {
      const phase = existing.status?.phase;
      if (phase === 'Running') return;
      if (phase === 'Pending') return this.k8s.waitForPodReady(this._namespace, name);
      // Terminal / unknown → the pod is stale; remove it and re-provision against the same workspace.
      await this.k8s.deletePod(this._namespace, name);
    }

    const [setupScript, mounts] = await Promise.all([
      this.profile.materializeSetupScript(job.repoId),
      this.profile.materializeMounts(job.repoId),
    ]);

    // The namespace must exist before the first pod; idempotent, so safe to call every provision.
    await this.k8s.ensureNamespace(this._namespace);

    // Operator-visible lifecycle pill (the brain never sees it — see ProvisionStatusService).
    await this.status.write(job, 'provisioning', 'Starting sandbox…');
    try {
      try {
        await this.k8s.createPod(
          this._namespace,
          this.buildPodSpec(job, name, setupScript, mounts),
        );
      } catch (err) {
        // Lost the provision race — the winner's pod is coming up; just wait for it.
        if (!isK8sConflictError(err)) throw err;
      }
      await this.k8s.waitForPodReady(this._namespace, name);
      await this.status.write(job, 'ready', 'Sandbox ready');
    } catch (err) {
      const message = SandboxService.provisionReason(err);
      await this.status.write(job, 'failed', `Sandbox failed to start — ${message}`);
      throw err;
    }
  }

  async launchEngineTurn(jobId: string, turnId: string): Promise<void> {
    await this.ensureReady(jobId);
    // Bootstrap infra ONLY — the env the engine needs *before* it can read its spec from Redis. Per-turn
    // credentials (agent auth + git) ride `TurnSpec.env`, assembled host-side by TurnSpecBuilder.
    const env: Record<string, string> = {
      TURN_ID: turnId,
      ENGINE_TRANSPORT: 'redis',
      REDIS_URL: this._sandboxRedisUrl,
      CLAUDE_CODE_SHELL_PREFIX: SHELL_PREFIX_WRAPPER,
    };
    // Each value is single-quoted so values with spaces survive the shell.
    const assignments = Object.entries(env)
      .map(([k, v]) => `${k}=${shQuote(v)}`)
      .join(' ');
    // setsid detaches the engine from the exec session so the stream closes while the process keeps running.
    const cmd = `setsid env ${assignments} ${ENGINE_ENTRYPOINT} </dev/null >/tmp/engine-${turnId}.log 2>&1 &`;
    await this.k8s.execInPod(this._namespace, SandboxService.podName(jobId), MAIN_CONTAINER, [
      'sh',
      '-c',
      cmd,
    ]);
    await this.touch(jobId);
  }

  /** Refresh the liveness lease. Called by the dispatcher on real engine activity, keeping the pod alive. */
  async touch(jobId: string): Promise<void> {
    await this.redis.set(SandboxService.leaseKey(jobId), '1', 'EX', LEASE_TTL_S);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reap(): Promise<void> {
    if (this.isTestDb) return;
    let pods: V1Pod[];
    try {
      pods = await this.k8s.listPodsByLabel(this._namespace, LABEL_JOB);
    } catch (err) {
      this.logger.warn(`reap list failed: ${String(err)}`);
      return;
    }
    for (const pod of pods) {
      const name = pod.metadata?.name;
      const jobId = pod.metadata?.labels?.[LABEL_JOB];
      if (!name || !jobId) continue;
      if (await this.redis.exists(SandboxService.leaseKey(jobId))) continue;
      try {
        await this.k8s.deletePod(this._namespace, name);
        this.logger.log(`reaped idle sandbox ${name} (job ${jobId}); workspace persists`);
      } catch (err) {
        this.logger.warn(`reap delete ${name} failed: ${String(err)}`);
      }
    }
  }

  private buildPodSpec(
    job: Job,
    name: string,
    setupScript: string | null,
    mounts: WorkspaceMountView[],
  ): V1Pod {
    // Profile mounts are subPaths of the same durable `work` volume, mounted at their own in-workspace path.
    // The atlas-state mount lives OUTSIDE /workspace so Atlas bookkeeping (the sentinel) never touches the repo.
    const sharedMounts: V1VolumeMount[] = [
      { name: WORK_VOLUME, mountPath: WORK_MOUNT },
      ...mounts.map((m) => ({
        name: WORK_VOLUME,
        mountPath: m.path,
        subPath: SandboxService.subPathFor(m.path),
      })),
      { name: ATLAS_STATE_VOLUME, mountPath: ATLAS_STATE_MOUNT },
    ];

    // Only carry a setup init container when the repo actually configures a setup script; otherwise the pod is
    // a bare runtime over the pre-materialized workspace.
    const initContainers: V1Container[] = setupScript?.trim()
      ? [
          {
            name: SETUP_CONTAINER,
            image: this._image,
            imagePullPolicy: 'Always',
            command: ['sh', '-c', SandboxService.setupWrapper(setupScript)],
            volumeMounts: sharedMounts,
          },
        ]
      : [];

    return {
      metadata: {
        name,
        namespace: this._namespace,
        labels: { [LABEL_ORG]: job.orgId, [LABEL_JOB]: job.id },
      },
      spec: {
        restartPolicy: 'Never',
        volumes: [
          {
            name: WORK_VOLUME,
            hostPath: {
              path: `${this._atlasData}/workspaces/${job.id}`,
              type: 'DirectoryOrCreate',
            },
          },
          {
            name: ATLAS_STATE_VOLUME,
            hostPath: { path: `${this._atlasData}/state/${job.id}`, type: 'DirectoryOrCreate' },
          },
          { name: DOCKER_STORAGE_VOLUME, emptyDir: {} },
        ],
        initContainers,
        containers: [
          {
            name: MAIN_CONTAINER,
            image: this._image,
            imagePullPolicy: 'Always',
            securityContext: {
              privileged: true,
            },
            resources: POD_RESOURCES,
            volumeMounts: [
              ...sharedMounts,
              { name: DOCKER_STORAGE_VOLUME, mountPath: DOCKER_STORAGE_MOUNT },
            ],
          },
        ],
      },
    };
  }

  private static podName(jobId: string): string {
    return `${POD_NAME_PREFIX}${jobId}`;
  }

  private static leaseKey(jobId: string): string {
    return `sbx:active:${jobId}`;
  }

  /** Human reason for a failed provision — the terminal pod reason when we have one, else the raw message. */
  private static provisionReason(err: unknown): string {
    if (err instanceof TerminalPodError) return err.reason;
    return err instanceof Error ? err.message : String(err);
  }

  /** Deterministic subPath under the `work` volume for a profile mount path. */
  private static subPathFor(path: string): string {
    return path.replace(/^\/+/, '').replace(/\//g, '_') || 'root';
  }

  /**
   * Wrap the repo's setup script to run in the worktree. Intentionally NOT sentinel-gated: the setup script runs
   * on every sandbox (re)start, and repos rely on that (some do per-boot work in it), so a cold boot after a reap
   * re-runs it — the script owns its own idempotency.
   */
  private static setupWrapper(setupScript: string): string {
    return ['set -e', `cd ${WORK_MOUNT}`, setupScript].join('\n');
  }
}

/** POSIX single-quote a value so it passes through `sh -c` verbatim (spaces, colons, `$`, etc.). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
