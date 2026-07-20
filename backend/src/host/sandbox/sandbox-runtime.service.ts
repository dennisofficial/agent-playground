import { EnvService } from '@core/config/env/env.service';
import { type V1Pod } from '@kubernetes/client-node';
import { Job, JobRepo } from '@lib/database/entities/job.entity';
import { K8sService } from '@lib/k8s/k8s.service';
import { isK8sConflictError } from '@lib/k8s/k8s.utils';
import { REDIS_CLIENT } from '@lib/redis/redis.tokens';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import {
  type WorkspaceMountView,
  WorkspaceProfileService,
} from '../workspace-profile/workspace-profile.service';

const LABEL_ORG = 'atlas.io/org';
const LABEL_JOB = 'atlas.io/job';
const POD_NAME_PREFIX = 'sbx-';

/** The engine container (the exec target). Kept idle between turns; each turn execs into it. */
const MAIN_CONTAINER = 'main';
/** The one-shot cold-boot container: git clone + workspace-profile setup, gated by the sentinel. */
const BOOTSTRAP_CONTAINER = 'bootstrap';

/** Durable worktree lives here; the sentinel marks a completed provision so resumes skip setup. */
const WORK_MOUNT = '/work';
const PROVISIONED_SENTINEL = `${WORK_MOUNT}/.atlas/provisioned`;

/** The engine entrypoint baked into the sandbox image; launched per turn via exec. */
const ENGINE_ENTRYPOINT = 'atlas-engine-turn';

/**
 * How long a sandbox may sit with no real engine activity before the reaper deletes its pod. The
 * lease is refreshed by {@link SandboxRuntime.touch} off actual turn events, NOT off `job.activity`.
 */
const LEASE_TTL_S = 30 * 60;

const podName = (jobId: string): string => `${POD_NAME_PREFIX}${jobId}`;
const leaseKey = (jobId: string): string => `sbx:active:${jobId}`;

/**
 * The runtime that hosts the in-process `engine` for a job. Not a user resource — a lazily materialized,
 * resumable side effect of running a turn. K8s is authoritative: the Pod is the runtime, the mount is the
 * durable identity (a reaped sandbox loses its pod, not its files). No DB row. State that must survive a
 * reap lives on the mount (sentinel) or in the Redis liveness lease.
 *
 * Config (image is infra; mounts/secrets/setup come from the repo's {@link WorkspaceProfileService}) is the
 * "what"; this service is the "how" — it materializes that config into a pod and execs the engine into it.
 */
@Injectable()
export class SandboxRuntime {
  private readonly logger = new Logger(SandboxRuntime.name);
  private readonly namespace: string;
  private readonly image: string;
  private readonly redisUrl: string;
  private readonly isTestDb: boolean;

  constructor(
    private readonly jobs: JobRepo,
    private readonly profile: WorkspaceProfileService,
    private readonly k8s: K8sService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    env: EnvService,
  ) {
    this.namespace = env.get('K8S_NAMESPACE');
    this.image = env.get('SANDBOX_IMAGE');
    this.redisUrl = env.get('REDIS_URL');
    this.isTestDb = /_test$/.test(env.get('POSTGRES_DB'));
  }

  /**
   * Ensure a Ready runtime exists for the job. Idempotent and race-safe (the deterministic pod name lets
   * k8s reject a concurrent create with 409, which we treat as "someone else is provisioning"). Provisions
   * on a cold start, resumes after a reap, returns immediately when already Running.
   */
  async ensureReady(jobId: string): Promise<void> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);

    const name = podName(jobId);
    const existing = await this.k8s.getPod(this.namespace, name);
    if (existing) {
      const phase = existing.status?.phase;
      if (phase === 'Running') return;
      if (phase === 'Pending') return this.k8s.waitForPodReady(this.namespace, name);
      // Terminal / unknown → the pod is stale; remove it and re-provision against the same mount.
      await this.k8s.deletePod(this.namespace, name);
    }

    // Config comes from the repo's workspace profile; the mount carries setup state across reaps.
    const [setupScript, mounts] = await Promise.all([
      this.profile.materializeSetupScript(job.repoId),
      this.profile.materializeMounts(job.repoId),
    ]);
    // TODO(secrets): materialize decrypted secret files (WorkspaceProfileService.materializeSecrets)
    //   as a per-job k8s Secret volume once the profile logic + git-auth for clone land.

    try {
      await this.k8s.createPod(this.namespace, this.buildPodSpec(job, name, setupScript, mounts));
    } catch (err) {
      if (!isK8sConflictError(err)) throw err;
      // Lost the provision race — the winner's pod is coming up; just wait for it.
    }
    await this.k8s.waitForPodReady(this.namespace, name);
  }

  /**
   * Ensure the runtime is Ready, then launch the engine for `turnId` inside it (detached — events flow
   * back over Redis independently, tailed by the turn dispatcher). Sets the liveness lease so a
   * just-started turn is never reaped mid-flight.
   */
  async launchEngineTurn(jobId: string, turnId: string): Promise<void> {
    await this.ensureReady(jobId);
    const env = [`TURN_ID=${turnId}`, 'ENGINE_TRANSPORT=redis', `REDIS_URL=${this.redisUrl}`];
    // setsid detaches the engine from the exec session so the stream closes while the process keeps running.
    const cmd = `setsid env ${env.join(' ')} ${ENGINE_ENTRYPOINT} </dev/null >/tmp/engine-${turnId}.log 2>&1 &`;
    await this.k8s.execInPod(this.namespace, podName(jobId), MAIN_CONTAINER, ['sh', '-c', cmd]);
    await this.touch(jobId);
  }

  /** Refresh the liveness lease. Called by the dispatcher on real engine activity, keeping the pod alive. */
  async touch(jobId: string): Promise<void> {
    await this.redis.set(leaseKey(jobId), '1', 'EX', LEASE_TTL_S);
  }

  /**
   * Delete pods whose liveness lease has expired — i.e. no real engine activity for {@link LEASE_TTL_S}.
   * Mounts persist, so a reap is a resume point, not a loss. K8s + Redis only; never reads the jobs DB.
   * Single host (no leader). Silent no-op on the test DB.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reap(): Promise<void> {
    if (this.isTestDb) return;
    let pods: V1Pod[];
    try {
      pods = await this.k8s.listPodsByLabel(this.namespace, LABEL_JOB);
    } catch (err) {
      this.logger.warn(`reap list failed: ${String(err)}`);
      return;
    }
    for (const pod of pods) {
      const name = pod.metadata?.name;
      const jobId = pod.metadata?.labels?.[LABEL_JOB];
      if (!name || !jobId) continue;
      if (await this.redis.exists(leaseKey(jobId))) continue;
      try {
        await this.k8s.deletePod(this.namespace, name);
        this.logger.log(`reaped idle sandbox ${name} (job ${jobId}); mounts persist`);
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
    // First pass: a single `work` volume backs the durable worktree + all profile mount paths (subPath).
    // TODO(mounts): honor per-EMountMode semantics and back `work` with a per-job PVC (durable across
    //   reaps) instead of emptyDir; wire shared-ro/shared-rw volumes.
    const volumeMounts = [
      { name: 'work', mountPath: WORK_MOUNT },
      ...mounts.map((m) => ({ name: 'work', mountPath: m.path, subPath: subPathFor(m.path) })),
    ];

    return {
      metadata: {
        name,
        namespace: this.namespace,
        labels: { [LABEL_ORG]: job.orgId, [LABEL_JOB]: job.id },
      },
      spec: {
        restartPolicy: 'Never',
        volumes: [{ name: 'work', emptyDir: {} }],
        // Sentinel-gated cold boot: on a fresh mount run setup and mark it done; on a resume, skip.
        initContainers: [
          {
            name: BOOTSTRAP_CONTAINER,
            image: this.image,
            command: ['sh', '-c', bootstrapScript(setupScript)],
            volumeMounts,
          },
        ],
        containers: [
          {
            name: MAIN_CONTAINER,
            image: this.image,
            // Idle host: stays alive so each turn can exec the engine into it.
            command: ['sh', '-c', 'exec sleep infinity'],
            volumeMounts,
          },
        ],
      },
    };
  }
}

/** Deterministic subPath under the `work` volume for a profile mount path. */
function subPathFor(path: string): string {
  return path.replace(/^\/+/, '').replace(/\//g, '_') || 'root';
}

/** Sentinel-gated bootstrap: run the profile setup once, then mark the mount provisioned. */
function bootstrapScript(setupScript: string | null): string {
  const setup = setupScript?.trim()
    ? setupScript
    : 'echo "no setup script configured for this repo"';
  // TODO(git): clone the repo here (needs git-auth from the repo/github layer) before running setup.
  return [
    `if [ -f ${PROVISIONED_SENTINEL} ]; then echo "sandbox already provisioned — resuming"; exit 0; fi`,
    'set -e',
    setup,
    `mkdir -p "$(dirname ${PROVISIONED_SENTINEL})"`,
    `touch ${PROVISIONED_SENTINEL}`,
  ].join('\n');
}
