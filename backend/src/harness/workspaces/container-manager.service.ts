import { EnvService } from '@core/config/env/env.service';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { createMutex } from '../domain/async';
import { ProjectStore } from '../projects/project-store';
import {
  CONTAINER_ENGINE,
  type ContainerEnginePort,
  type ContainerLabels,
  type ContainerSummary,
  type CreateContainerSpec,
} from './container-engine.port';
import { CredentialProvisionerService } from './credential-provisioner.service';
import {
  SandboxRegistry,
  type SandboxRecord,
  type SandboxStatus,
} from './sandbox-registry';

// ── Managed labels — the reconcile contract. The host rebuilds its registry from these on boot. ──
const LABEL_WORKSPACE = 'com.agent.workspace';
const LABEL_TEAM = 'com.agent.team';
const LABEL_PROJECT = 'com.agent.project';
const LABEL_REPO = 'com.agent.repo';
const LABEL_MANAGED = 'com.agent.managed';

/** Resource defaults — conservative single-box limits (the locked privileged-DinD tradeoff makes
 * these a blast-radius backstop, not real isolation). Tunable later via env if needed. */
const DEFAULT_MEMORY_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
const DEFAULT_NANO_CPUS = 2 * 1_000_000_000; // 2 CPUs
const DEFAULT_PIDS_LIMIT = 2048;

/** Default privileged runtime (the host's default OCI runtime); reserve `sysbox-runc` as a future
 * hardening switch via `WORKSPACE_RUNTIME`. `runc` is the dockerode/Docker default — passing it
 * explicitly is a no-op but documents intent (and `WORKSPACE_RUNTIME=sysbox-runc` flips it). */
const DEFAULT_RUNTIME = 'runc';

/** Map a uuid into a Docker-safe container name. Docker names allow `[a-zA-Z0-9][a-zA-Z0-9_.-]+`. */
function containerName(uuid: string): string {
  const safe = uuid.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `agent-ws-${safe}`;
}

/** Strip any char Docker labels / our keys shouldn't carry (defence-in-depth on team/project ids). */
function sanitizeLabelValue(v: string): string {
  return v.replace(/[\r\n]/g, '').trim();
}

/**
 * The HOST sandbox-container lifecycle (Phase 6). Spawns + tracks one privileged DinD sandbox per
 * workspace and reconciles the in-memory `SandboxRegistry` from Docker labels on boot — mirroring
 * `WorkspaceService.adoptWorkspaces` (which reconciles from `git worktree list`), but from
 * `listContainers({label: com.agent.managed=1})` instead.
 *
 * Confinement: this service is the ONLY consumer of the `ContainerEnginePort` (the Docker socket). All
 * mutating ops serialize through one mutex (mirroring `WorkspaceService.gitOps`) so concurrent
 * `ensureWorkspace` calls for the same `(team, project)` can't double-create. Every id is sanitized
 * into the container params; the bootstrap token is short + random and lives only in-process.
 *
 * NOTHING CALLS `ensureWorkspace` yet — the session-lifecycle wiring is Phase 9. This phase builds +
 * unit-tests the capability in isolation; the registered ensurer is consumed by Phase 7's dispatcher.
 */
@Injectable()
export class ContainerManagerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContainerManagerService.name);
  private readonly ops = createMutex();

  constructor(
    @Inject(CONTAINER_ENGINE) private readonly engine: ContainerEnginePort,
    private readonly env: EnvService,
    private readonly projects: ProjectStore,
    private readonly registry: SandboxRegistry,
    private readonly credentials: CredentialProvisionerService,
  ) {
    // One-directional DI: register the lazy-create entry point so `SandboxRegistry.resolveForSession`
    // can ensure a sandbox without injecting this service back (no DI cycle).
    this.registry.bindEnsurer((team, project) =>
      this.ensureWorkspace(team, project),
    );
  }

  /**
   * Idempotent: return the existing sandbox for `(team, project)` (find-by-label, so it survives a
   * registry that hasn't reconciled yet), else create + start a fresh privileged DinD sandbox. Returns
   * the registry record (workspaceId = the uuid).
   */
  async ensureWorkspace(
    team: string,
    project: string,
  ): Promise<SandboxRecord> {
    return this.ops(async () => {
      const existing = await this.findRunning(team, project);
      if (existing) {
        this.registry.upsert(existing);
        await this.credentials.watch(existing.workspaceId);
        return existing;
      }
      return this.create(team, project);
    });
  }

  /** Find a live (or stopped) managed sandbox for `(team, project)` directly from Docker labels —
   * the source of truth, independent of the in-memory registry's reconcile state. */
  private async findRunning(
    team: string,
    project: string,
  ): Promise<SandboxRecord | undefined> {
    const containers = await this.engine
      .listContainers({
        all: true,
        label: [
          `${LABEL_MANAGED}=1`,
          `${LABEL_TEAM}=${sanitizeLabelValue(team)}`,
          `${LABEL_PROJECT}=${sanitizeLabelValue(project)}`,
        ],
      })
      .catch((err) => {
        this.logger.warn(`listContainers (find) failed: ${String(err)}`);
        return [] as ContainerSummary[];
      });
    const found = containers[0];
    if (!found) return undefined;
    const record = this.toRecord(found);
    // A found-by-label sandbox keeps whatever token the registry already holds (created this process);
    // an externally-running one has none until recreated.
    return {
      ...record,
      bootstrapToken: this.registry.get(record.workspaceId)?.bootstrapToken,
    };
  }

  private async create(team: string, project: string): Promise<SandboxRecord> {
    const image = this.env.get('WORKSPACE_IMAGE');
    if (!image) {
      throw new Error(
        'WORKSPACE_IMAGE is not set — set it to the sandbox base image (pinned by digest in deploy).',
      );
    }
    const repo = await this.repoUrl(team, project);
    const workspaceId = randomUUID();
    const name = containerName(workspaceId);
    const bootstrapToken = randomBytes(24).toString('hex');
    const redisUrl = this.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379';

    const labels: ContainerLabels = {
      [LABEL_MANAGED]: '1',
      [LABEL_WORKSPACE]: workspaceId,
      [LABEL_TEAM]: sanitizeLabelValue(team),
      [LABEL_PROJECT]: sanitizeLabelValue(project),
      [LABEL_REPO]: sanitizeLabelValue(repo),
    };

    const spec: CreateContainerSpec = {
      name,
      image,
      // The daemon connects OUT to Redis and consumes ws:{WORKSPACE_ID}:cmds; the bootstrap token auths
      // the cred-pull channel. NO secrets here beyond the short bootstrap token (the GitHub PAT + LLM
      // key arrive over the bus per-request / per-run, never baked into the container env).
      env: [
        `REDIS_URL=${redisUrl}`,
        `WORKSPACE_ID=${workspaceId}`,
        `DAEMON_BOOTSTRAP_TOKEN=${bootstrapToken}`,
      ],
      labels,
      privileged: true, // inner DinD (Phase 10) — the locked tradeoff
      runtime: this.env.get('WORKSPACE_RUNTIME') ?? DEFAULT_RUNTIME,
      // A per-sandbox named volume for the inner Docker's storage so `/var/lib/docker` is private + the
      // host's docker-storage is never shared (the collision fix). Volume name = the workspace id.
      binds: [`agent-ws-docker-${workspaceId}:/var/lib/docker`],
      restartPolicy: 'unless-stopped',
      memoryBytes: DEFAULT_MEMORY_BYTES,
      nanoCpus: DEFAULT_NANO_CPUS,
      pidsLimit: DEFAULT_PIDS_LIMIT,
      // NOTE: no ports field at all — sandboxes have NO host port bindings / NO published ports.
    };

    this.logger.log(
      `creating sandbox ${workspaceId} (${name}) for ${team}/${project}`,
    );
    const handle = await this.engine.createContainer(spec);
    await this.engine.startContainer(handle.id);

    const record: SandboxRecord = {
      workspaceId,
      team,
      project,
      repo,
      containerId: handle.id,
      status: 'running',
      bootstrapToken,
    };
    this.registry.upsert(record);
    await this.credentials.watch(workspaceId);
    return record;
  }

  /** Stop + remove a sandbox container. Idempotent: an unknown/gone workspace is a no-op. */
  async destroyWorkspace(workspaceId: string): Promise<void> {
    await this.ops(async () => {
      const rec = this.registry.get(workspaceId);
      if (!rec) {
        this.logger.warn(`destroyWorkspace: unknown workspace ${workspaceId}`);
        return;
      }
      this.logger.log(`destroying sandbox ${workspaceId} (${rec.containerId})`);
      await this.engine
        .stopContainer(rec.containerId)
        .catch((err) =>
          this.logger.warn(`stop ${workspaceId} failed: ${String(err)}`),
        );
      await this.engine
        .removeContainer(rec.containerId)
        .catch((err) =>
          this.logger.warn(`remove ${workspaceId} failed: ${String(err)}`),
        );
      await this.credentials.unwatch(workspaceId);
      this.registry.remove(workspaceId);
    });
  }

  /** Boot reconciliation: rebuild the in-memory registry from every managed container's labels —
   * mirrors `WorkspaceService.adoptWorkspaces`. Resilient: a Docker-absent host just logs + skips
   * (containerized sessions are unavailable until Docker appears), never failing boot. */
  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile().catch((err) =>
      this.logger.warn(
        `sandbox reconciliation skipped: ${err instanceof Error ? err.message : err}`,
      ),
    );
  }

  async reconcile(): Promise<void> {
    await this.ops(async () => {
      const containers = await this.engine.listContainers({
        all: true,
        label: [`${LABEL_MANAGED}=1`],
      });
      this.registry.clear();
      for (const c of containers) {
        const record = this.toRecord(c);
        if (!record.workspaceId) {
          this.logger.warn(
            `adoption: container ${c.id} has com.agent.managed but no ${LABEL_WORKSPACE} label — skipped`,
          );
          continue;
        }
        // No bootstrap token survives a restart (it was never a label / never persisted) — an adopted
        // sandbox can't serve the cred-channel until it's recreated. Documented limitation. We still
        // WATCH its cred-req channel so a request gets a clean rejection (not silence) until recreate.
        this.registry.upsert(record);
        await this.credentials.watch(record.workspaceId);
        this.logger.log(
          `adopted sandbox ${record.workspaceId} (${record.team}/${record.project}, ${record.status})`,
        );
      }
    });
  }

  /** Parse a managed container's labels into a registry record (boot reconcile + find share this). */
  private toRecord(c: ContainerSummary): SandboxRecord {
    return {
      workspaceId: c.labels[LABEL_WORKSPACE] ?? '',
      team: c.labels[LABEL_TEAM] ?? '',
      project: c.labels[LABEL_PROJECT] ?? '',
      repo: c.labels[LABEL_REPO] ?? '',
      containerId: c.id,
      status: toStatus(c.state),
    };
  }

  /** The project's registered GitHub repo URL (for the `com.agent.repo` label). Empty when the project
   * isn't registered — Phase 9 only containerizes registered projects, but this stays tolerant. */
  private async repoUrl(team: string, project: string): Promise<string> {
    const rec = await this.projects.get(team, project).catch(() => undefined);
    return rec?.gitUrl ?? '';
  }
}

/** Map a Docker container state string to our coarse sandbox status. */
function toStatus(state: string): SandboxStatus {
  switch (state) {
    case 'running':
      return 'running';
    case 'created':
    case 'restarting':
      return 'starting';
    case 'exited':
    case 'dead':
    case 'paused':
      return 'stopped';
    default:
      return state ? 'running' : 'gone';
  }
}
