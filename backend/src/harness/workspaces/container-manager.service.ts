import { EnvService } from '@core/config/env/env.service';
import type { IEnvConfig } from '@core/config/env/validation';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
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
import { DaemonClient } from './daemon-client';
import {
  REFS_MOUNT,
  ReferenceLibraryService,
} from './reference-library.service';
import { SandboxReadinessService } from './sandbox-readiness.service';
import {
  SandboxRegistry,
  type SandboxRecord,
  type SandboxStatus,
} from './sandbox-registry';
import { WorkspaceProvisionerService } from './workspace-provisioner.service';

// ── Managed labels — the reconcile contract. The host rebuilds its registry from these on boot. ──
const LABEL_WORKSPACE = 'com.agent.workspace';
const LABEL_TEAM = 'com.agent.team';
const LABEL_PROJECT = 'com.agent.project';
const LABEL_REPO = 'com.agent.repo';
const LABEL_MANAGED = 'com.agent.managed';
/** The per-branch sandbox (workstation) identity: a sandbox is keyed `(team, project, branch)`. The branch
 * (and its baseRef/upstream — what to cut it from / where it PRs into) live on labels so they SURVIVE a
 * host restart and are re-adopted on boot, and as env so the daemon checks the branch out at boot. */
const LABEL_BRANCH = 'com.agent.branch';
const LABEL_BASE_REF = 'com.agent.base-ref';
const LABEL_UPSTREAM = 'com.agent.upstream';
/**
 * The short bootstrap token, persisted as a label so a sandbox RE-ADOPTED on boot can still serve the
 * cred-pull channel (the in-process token doesn't survive a host restart). This is the ONLY secret on a
 * label, and a DELIBERATE, scoped tradeoff: it's only the short bootstrap token (the cred-channel auth),
 * NOT the GitHub PAT / LLM key (those never touch the container env — they ride the bus per request/run).
 * A `docker inspect`-readable bootstrap token lets a local attacker pull the GitHub credential for that
 * workspace; acceptable on the single-owner box, and the alternative (a host-side durable store) buys
 * little when an attacker with socket access can already read far more. Without this, an adopted sandbox
 * can't serve creds until it's recreated.
 */
const LABEL_BOOT_TOKEN = 'com.agent.boot-token';
/** Last-activity stamp (ms epoch as a string) the idle reaper reads to decide whether a branch-scoped
 * workstation is past its TTL. Stamped at CREATE and refreshed by `touch()` on session events. Read from
 * the live registry record (in-process); survives a restart on the label so a re-adopted workstation
 * keeps its age (a missing label → treated as "active now", i.e. not yet idle, so the reaper is patient). */
const LABEL_LAST_ACTIVE = 'com.agent.last-active';
/**
 * The host port this workstation's dev server is published on (`127.0.0.1:<devPort>` → the sandbox's
 * `WORKSPACE_DEV_PORT`). The DURABLE source of truth for the allocator: "taken" = any existing
 * `com.agent.devport` across managed containers, so the lowest-free pick survives a host restart and never
 * double-binds. Also the seam a future DEPLOYMENT reverse-proxy keys on (e.g. Caddy routing `<id>.domain`
 * → this host port) — so the label-based allocation is reverse-proxy-ready; we bind localhost-only for now. */
const LABEL_DEV_PORT = 'com.agent.devport';

/** Idle-reaper cadence: how often the sweep runs (the TTL is the real dial; the sweep just samples). */
const REAP_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
/** Default idle TTL before a clean, session-less workstation is eligible for reaping (override via
 * `WORKSPACE_IDLE_TTL_MINUTES`). 24h — long enough that a workstation parked overnight survives. */
const DEFAULT_IDLE_TTL_MINUTES = 1440;
/** Default cap on live branch-scoped workstations per (team, project) (override via
 * `WORKSPACE_MAX_PER_PROJECT`). create_workspace REFUSES past this — never auto-evicts (data-loss trap). */
const DEFAULT_MAX_PER_PROJECT = 8;

/** Resource defaults — conservative single-box limits (the locked privileged-DinD tradeoff makes
 * these a blast-radius backstop, not real isolation). Tunable later via env if needed. */
const DEFAULT_MEMORY_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
const DEFAULT_NANO_CPUS = 2 * 1_000_000_000; // 2 CPUs
const DEFAULT_PIDS_LIMIT = 2048;

/** Default privileged runtime (the host's default OCI runtime); reserve `sysbox-runc` as a future
 * hardening switch via `WORKSPACE_RUNTIME`. `runc` is the dockerode/Docker default — passing it
 * explicitly is a no-op but documents intent (and `WORKSPACE_RUNTIME=sysbox-runc` flips it). */
const DEFAULT_RUNTIME = 'runc';

/** The container-side dev-server port each workstation publishes (the convention the agent targets: run
 * your dev server in the inner compose published to `0.0.0.0:<WORKSPACE_DEV_PORT>`). Override via
 * `WORKSPACE_DEV_PORT`. 7000 by default. */
const DEFAULT_DEV_PORT = 7000;
/** The host-side allocation pool `[start..end]` for the published dev port (`127.0.0.1:<allocated>`). The
 * allocator picks the lowest free port not already stamped on a managed container's `com.agent.devport`
 * label. Override via `WORKSPACE_PORT_RANGE_START`/`WORKSPACE_PORT_RANGE_END`. */
const DEFAULT_PORT_RANGE_START = 39000;
const DEFAULT_PORT_RANGE_END = 39999;

/** Where the Linux-built daemon is MOUNTED read-only inside every sandbox, and its entry file. The build
 * is a named volume produced by `pnpm daemon:build` (not baked into the generic image), so a daemon code
 * change is a `pnpm daemon:build` + restart, never an image rebuild. */
const DAEMON_MOUNT = '/daemon';
const DAEMON_ENTRY = `${DAEMON_MOUNT}/backend/dist/daemon/main.js`;
/** Default name of the daemon-build volume (override via `WORKSPACE_DAEMON_BUILD_VOLUME`). */
const DEFAULT_DAEMON_BUILD_VOLUME = 'agent-daemon-build';

/** In-sandbox roots the daemon reads. Defaults also live in the daemon's `env.validation.ts`; injected
 * here per-container so the GENERIC image bakes no runtime env (the host owns the deployment shape).
 * NOTE: deliberately NO `NODE_ENV=production` — these are dev workspaces, not prod servers. */
const SANDBOX_AGENT_HOME_ROOT = '/workspace/.agent-home';
const SANDBOX_WORKSPACE_ROOT = '/workspace/repo';

/** The per-sandbox inner-docker storage volume name (private `/var/lib/docker` — the collision fix). */
function dockerStorageVolume(workspaceId: string): string {
  return `agent-ws-docker-${workspaceId}`;
}

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
export class ContainerManagerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ContainerManagerService.name);
  private readonly ops = createMutex();
  /** Caches the one-time daemon-build presence check (the build volume doesn't change under us). */
  private buildChecked = false;
  /** The idle-reaper timer (guarded `setInterval`, unref'd; cleared on shutdown). */
  private reapTimer?: NodeJS.Timeout;
  /** In-memory last-activity stamp per workspaceId (ms epoch) — the freshest signal, refreshed by
   * `touch()` on session events. The `com.agent.last-active` label is the durable mirror (read on a
   * restart via `toRecord` → the registry); this map wins when present. */
  private readonly lastActiveAt = new Map<string, number>();
  /**
   * The bound open-sessions probe — returns how many NON-closed sessions a workspace has. One-directional
   * DI: `SESSION_REGISTRY` lives in `SessionsModule`, which IMPORTS this module, so the manager can't
   * inject it (cycle). A boot-time bridge in `SessionsModule` registers this (mirrors `bindEnsurer`). Until
   * bound, the reaper conservatively treats EVERY workspace as having open sessions (never reaps), so a
   * boot-order gap can't cause data loss.
   */
  private openSessionsProbe?: (workspaceId: string) => Promise<number>;

  constructor(
    @Inject(CONTAINER_ENGINE) private readonly engine: ContainerEnginePort,
    private readonly env: EnvService,
    private readonly projects: ProjectStore,
    private readonly registry: SandboxRegistry,
    private readonly credentials: CredentialProvisionerService,
    private readonly readiness: SandboxReadinessService,
    private readonly provisioner: WorkspaceProvisionerService,
    private readonly refs: ReferenceLibraryService,
    private readonly daemon: DaemonClient,
  ) {
    // One-directional DI: register the lazy-create entry point so `SandboxRegistry.resolveForSession`
    // can ensure a sandbox without injecting this service back (no DI cycle).
    this.registry.bindEnsurer((team, project, branch, baseRef, upstream) =>
      this.ensureWorkspace(team, project, branch, baseRef, upstream),
    );
  }

  /** Register the open-sessions probe (a `SessionsModule` boot bridge calls this — the SESSION_REGISTRY
   * import direction forbids the reverse DI; mirrors `SandboxRegistry.bindEnsurer`). */
  bindOpenSessionsProbe(probe: (workspaceId: string) => Promise<number>): void {
    this.openSessionsProbe = probe;
  }

  /** Refresh a workspace's last-activity stamp (called on session lifecycle events via the same bridge).
   * Keeps an idle TTL honest so an actively-worked workstation is never reaped. No-op for an unknown id. */
  touch(workspaceId: string): void {
    if (!this.registry.get(workspaceId)) return;
    this.lastActiveAt.set(workspaceId, Date.now());
  }

  /**
   * Idempotent: return the existing workstation for `(team, project, branch)` (find-by-label, so it
   * survives a registry that hasn't reconciled yet — including the branch label, so a different-branch
   * sandbox of the same project is NOT reused), else create + start a fresh privileged DinD sandbox on
   * that branch. Returns the registry record (workspaceId = the uuid).
   */
  async ensureWorkspace(
    team: string,
    project: string,
    branch: string,
    baseRef: string,
    upstream: string,
  ): Promise<SandboxRecord> {
    return this.ops(async () => {
      const existing = await this.findRunning(team, project, branch);
      if (existing) {
        this.registry.upsert(existing);
        await this.credentials.watch(existing.workspaceId);
        return existing;
      }
      // The per-(team, project) cap is enforced only on a FRESH create — re-entering an existing branch
      // never trips it. We REFUSE (not auto-evict) past the cap: auto-eviction risks the data-loss trap.
      await this.enforceProjectCap(team, project);
      return this.create(team, project, branch, baseRef, upstream);
    });
  }

  /** The live count of branch-scoped workstations for a (team, project) — straight from Docker labels (the
   * source of truth), so a registry that hasn't reconciled yet can't undercount. Used by the create cap. */
  private async countWorkstations(
    team: string,
    project: string,
  ): Promise<number> {
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
        this.logger.warn(`listContainers (cap) failed: ${String(err)}`);
        return [] as ContainerSummary[];
      });
    // Branch-scoped only (a non-empty branch label = a per-branch workstation; legacy no-branch sandboxes
    // are excluded from the cap so they can't block a fresh workstation create).
    return containers.filter((c) => !!c.labels[LABEL_BRANCH]).length;
  }

  /** Refuse a fresh create when the (team, project) already has the capped number of workstations. The
   * message is actionable: it names the cap and the manual next step (remove an idle one). NEVER auto-evicts
   * (that risks destroying a clone with unpushed/uncommitted work — the data-loss trap). */
  private async enforceProjectCap(
    team: string,
    project: string,
  ): Promise<void> {
    const cap = this.maxPerProject();
    const live = await this.countWorkstations(team, project);
    if (live >= cap) {
      throw new Error(
        `You already have ${live} workstations for this project (cap ${cap}). ` +
          `Remove an idle one with remove_workspace first (only after its PR is merged/closed), then try again.`,
      );
    }
  }

  /** The configured per-(team, project) workstation cap (env `WORKSPACE_MAX_PER_PROJECT`, default 8). */
  private maxPerProject(): number {
    const raw = this.env.get('WORKSPACE_MAX_PER_PROJECT');
    const n = raw ? Number.parseInt(String(raw), 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PER_PROJECT;
  }

  /** The configured idle TTL in ms (env `WORKSPACE_IDLE_TTL_MINUTES`, default 1440 = 24h). */
  private idleTtlMs(): number {
    const raw = this.env.get('WORKSPACE_IDLE_TTL_MINUTES');
    const n = raw ? Number.parseInt(String(raw), 10) : NaN;
    const minutes =
      Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_TTL_MINUTES;
    return minutes * 60 * 1000;
  }

  /** A positive integer env override, else the default. (Shared by the dev-port + range getters.) */
  private intEnv(key: keyof IEnvConfig, fallback: number): number {
    const raw = this.env.get(key);
    const n = raw ? Number.parseInt(String(raw), 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  /** The container-side dev port a workstation publishes (env `WORKSPACE_DEV_PORT`, default 7000). */
  private devPort(): number {
    return this.intEnv('WORKSPACE_DEV_PORT', DEFAULT_DEV_PORT);
  }

  /**
   * Allocate the lowest free HOST port in `[WORKSPACE_PORT_RANGE_START..WORKSPACE_PORT_RANGE_END]` to
   * publish this workstation's dev server on (`127.0.0.1:<port>`). "Taken" = any `com.agent.devport` label
   * across managed containers — Docker labels are the durable source of truth, so the pick survives a host
   * restart and never double-binds two live workstations onto the same host port. Returns undefined when
   * the pool is exhausted (the caller then creates the workstation WITHOUT a published port — exposure is
   * best-effort, never blocks getting work done).
   */
  private async allocateDevPort(): Promise<number | undefined> {
    const start = this.intEnv('WORKSPACE_PORT_RANGE_START', DEFAULT_PORT_RANGE_START);
    const end = this.intEnv('WORKSPACE_PORT_RANGE_END', DEFAULT_PORT_RANGE_END);
    const containers = await this.engine
      .listContainers({ all: true, label: [`${LABEL_MANAGED}=1`] })
      .catch((err) => {
        this.logger.warn(`listContainers (devport) failed: ${String(err)}`);
        return [] as ContainerSummary[];
      });
    const taken = new Set<number>();
    for (const c of containers) {
      const n = Number.parseInt(c.labels[LABEL_DEV_PORT] ?? '', 10);
      if (Number.isFinite(n)) taken.add(n);
    }
    for (let port = start; port <= end; port++) {
      if (!taken.has(port)) return port;
    }
    return undefined; // pool exhausted — caller falls back to no published port
  }

  /** Find a live (or stopped) managed workstation for `(team, project, branch)` directly from Docker
   * labels — the source of truth, independent of the in-memory registry's reconcile state. The BRANCH is
   * part of the filter so two sandboxes of the same project on different branches don't collide. */
  private async findRunning(
    team: string,
    project: string,
    branch: string,
  ): Promise<SandboxRecord | undefined> {
    const containers = await this.engine
      .listContainers({
        all: true,
        label: [
          `${LABEL_MANAGED}=1`,
          `${LABEL_TEAM}=${sanitizeLabelValue(team)}`,
          `${LABEL_PROJECT}=${sanitizeLabelValue(project)}`,
          `${LABEL_BRANCH}=${sanitizeLabelValue(branch)}`,
        ],
      })
      .catch((err) => {
        this.logger.warn(`listContainers (find) failed: ${String(err)}`);
        return [] as ContainerSummary[];
      });
    const found = containers[0];
    if (!found) return undefined;
    const record = this.toRecord(found);
    // Prefer the in-process registry token (created this process), else fall back to the one recovered
    // from the container label (`toRecord` already read it) — so a sandbox re-adopted across a restart
    // still has its bootstrap token and can serve the cred-pull.
    return {
      ...record,
      bootstrapToken:
        this.registry.get(record.workspaceId)?.bootstrapToken ??
        record.bootstrapToken,
    };
  }

  private async create(
    team: string,
    project: string,
    branch: string,
    baseRef: string,
    upstream: string,
  ): Promise<SandboxRecord> {
    const image = this.env.get('WORKSPACE_IMAGE');
    if (!image) {
      throw new Error(
        'WORKSPACE_IMAGE is not set — set it to the generic workspace base image (pinned by digest in deploy).',
      );
    }
    const buildVolume =
      this.env.get('WORKSPACE_DAEMON_BUILD_VOLUME') ??
      DEFAULT_DAEMON_BUILD_VOLUME;
    // Self-provision the base image + mounted daemon build (memoized — usually already warmed at boot),
    // so a deploy never needs a manual `pnpm daemon:build`. THEN the loud, early presence check below
    // still guards the spawn (it covers SKIP_DAEMON_BUILD with an empty volume).
    await this.provisioner.ensureProvisioned();
    // Fail loudly + early if the mounted daemon build is missing (rather than spawning a sandbox whose
    // daemon can't start). Checked once per process — the build volume doesn't change under us.
    await this.ensureBuildPresent(image, buildVolume);

    const { gitUrl: repo, baseBranch } = await this.repoCoordinates(
      team,
      project,
    );
    const workspaceId = randomUUID();
    const name = containerName(workspaceId);
    const bootstrapToken = randomBytes(24).toString('hex');
    // The Redis URL the SANDBOX uses — NOT the host's `REDIS_URL` (which may be `127.0.0.1:6380`,
    // unreachable from inside a container). `WORKSPACE_REDIS_URL` is the sandbox-reachable address
    // (service DNS on the shared network, default `redis://agent-playground-redis:6379`).
    const redisUrl =
      this.env.get('WORKSPACE_REDIS_URL') ??
      'redis://agent-playground-redis:6379';
    // The Docker network the sandbox joins so service-DNS Redis resolves. Default the compose default.
    const network =
      this.env.get('WORKSPACE_NETWORK') ?? 'agent-playground_default';
    // Inner dockerd storage driver — empty (auto/overlay2) on a real Linux host; `vfs` on Docker
    // Desktop where overlay-on-overlay can't mount. Empty → not injected (entrypoint auto-detects).
    const storageDriver = this.env.get('WORKSPACE_DOCKER_STORAGE_DRIVER') ?? '';

    // Reserve ONE localhost-only host port to publish this workstation's dev server on (the sandbox's
    // WORKSPACE_DEV_PORT → 127.0.0.1:<devPort>). Best-effort: a pool-exhausted result leaves devPort
    // undefined and the workstation is created with NO published port (exposure never blocks the work).
    const devPort = await this.allocateDevPort();
    const containerDevPort = this.devPort();
    if (devPort === undefined) {
      this.logger.warn(
        `dev-port pool exhausted — creating ${workspaceId} WITHOUT a published dev server (work continues).`,
      );
    }

    const labels: ContainerLabels = {
      [LABEL_MANAGED]: '1',
      [LABEL_WORKSPACE]: workspaceId,
      [LABEL_TEAM]: sanitizeLabelValue(team),
      [LABEL_PROJECT]: sanitizeLabelValue(project),
      [LABEL_REPO]: sanitizeLabelValue(repo),
      // Per-branch identity: the branch is the workstation key; baseRef/upstream survive a restart so a
      // re-adopted workstation can still create/PR its branch from the right refs.
      [LABEL_BRANCH]: sanitizeLabelValue(branch),
      [LABEL_BASE_REF]: sanitizeLabelValue(baseRef),
      [LABEL_UPSTREAM]: sanitizeLabelValue(upstream),
      // Persisted so a re-adopted sandbox can recover it and keep serving the cred-pull (see LABEL_BOOT_TOKEN).
      [LABEL_BOOT_TOKEN]: bootstrapToken,
      // Last-activity stamp (ms epoch) the idle reaper reads — created "now", refreshed on session events.
      [LABEL_LAST_ACTIVE]: String(Date.now()),
      // The allocated dev-server host port (when one was free) — the durable source of truth the allocator
      // reads to avoid double-binding, and what the reverse-proxy will key on later. Omitted when exhausted.
      ...(devPort !== undefined ? { [LABEL_DEV_PORT]: String(devPort) } : {}),
    };

    const dockerVolume = dockerStorageVolume(workspaceId);
    // The team's shared READ-ONLY reference library (one clone per registered project), mounted at /refs
    // so a worker can read the team's OTHER projects ambiently. Ensure the host source dir exists first
    // (Docker would otherwise auto-create the bind source as root). Team-scoped → tenant isolation.
    const refsSource = await this.refs.ensureTeamMountSource(team);
    const spec: CreateContainerSpec = {
      name,
      image,
      // The daemon connects OUT to Redis and consumes ws:{WORKSPACE_ID}:cmds; the bootstrap token auths
      // the cred-pull channel. NO secrets here beyond the short bootstrap token (the GitHub PAT + LLM
      // key arrive over the bus per-request / per-run, never baked into the container env). The repo
      // coordinates (NON-secret) drive the daemon's clone-on-boot; the storage driver is set only when
      // non-empty (so the entrypoint auto-detects on a host that doesn't need it).
      //
      // The runtime env that the GENERIC image deliberately no longer bakes (so the host owns the
      // deployment shape and the image stays project-agnostic): the mounted-daemon entry, the in-sandbox
      // roots, and the relaxed-guard signal. NO NODE_ENV=production — these are dev workspaces.
      env: [
        `REDIS_URL=${redisUrl}`,
        `WORKSPACE_ID=${workspaceId}`,
        `DAEMON_BOOTSTRAP_TOKEN=${bootstrapToken}`,
        `WORKSPACE_REPO_URL=${repo}`,
        `WORKSPACE_BASE_BRANCH=${baseBranch}`,
        // Per-branch checkout: the daemon checks out / creates WORKSPACE_BRANCH at boot, cutting it from
        // WORKSPACE_BASE_REF when it doesn't exist, and refreshes-from / PRs into WORKSPACE_UPSTREAM.
        `WORKSPACE_BRANCH=${branch}`,
        `WORKSPACE_BASE_REF=${baseRef}`,
        `WORKSPACE_UPSTREAM=${upstream}`,
        `DAEMON_ENTRY=${DAEMON_ENTRY}`,
        // The harness source root inside the sandbox = the daemon mount (the volume has no `.git`, so
        // `git rev-parse` can't find it). This anchors repo-local skill paths so a vendored skill like
        // `skills/code-review` resolves to `/daemon/skills/code-review` (NOT the cloned target repo).
        `HARNESS_ROOT=${DAEMON_MOUNT}`,
        `AGENT_HOME_ROOT=${SANDBOX_AGENT_HOME_ROOT}`,
        `WORKSPACE_ROOT=${SANDBOX_WORKSPACE_ROOT}`,
        `SANDBOX_GUARD_RELAXED=true`,
        ...(storageDriver ? [`DOCKERD_STORAGE_DRIVER=${storageDriver}`] : []),
      ],
      labels,
      privileged: true, // inner DinD — the locked tradeoff
      runtime: this.env.get('WORKSPACE_RUNTIME') ?? DEFAULT_RUNTIME,
      network,
      binds: [
        // The Linux-built daemon, mounted READ-ONLY (not baked into the image). DAEMON_ENTRY points here.
        `${buildVolume}:${DAEMON_MOUNT}:ro`,
        // A per-sandbox named volume for the inner Docker's storage so `/var/lib/docker` is private + the
        // host's docker-storage is never shared (the collision fix). Created+labelled just below so the
        // boot orphan-sweep can find it (a bind-auto-created volume carries no labels). NEVER shared.
        `${dockerVolume}:/var/lib/docker`,
        // The team's shared READ-ONLY reference library at /refs/<slug> — the host maintains it (clones
        // with each project's own token); the worker reads other projects from it ambiently. Read-only,
        // so it never dirties the workstation. New clones added to the team dir appear live (whole-dir bind).
        `${refsSource}:${REFS_MOUNT}:ro`,
      ],
      restartPolicy: 'unless-stopped',
      memoryBytes: DEFAULT_MEMORY_BYTES,
      nanoCpus: DEFAULT_NANO_CPUS,
      pidsLimit: DEFAULT_PIDS_LIMIT,
      // The SINGLE localhost-only published port: the container's WORKSPACE_DEV_PORT (7000) → the allocated
      // host port on 127.0.0.1 (never 0.0.0.0 — local-dev exposure only). The agent runs its dev server in
      // the inner compose published to 0.0.0.0:7000, reachable at http://localhost:<devPort>. Omitted when
      // the port pool was exhausted (the workstation still works, just without a viewable dev server).
      ...(devPort !== undefined
        ? {
            ports: [
              {
                hostIp: '127.0.0.1',
                hostPort: devPort,
                containerPort: containerDevPort,
              },
            ],
          }
        : {}),
    };

    this.logger.log(
      `creating sandbox ${workspaceId} (${name}) for ${team}/${project}`,
    );
    // Create + LABEL the inner-docker volume before the container, so it's findable by the boot
    // orphan-sweep (`listVolumes({label})` only sees labelled volumes) and removed on teardown.
    await this.engine.createVolume(dockerVolume, {
      [LABEL_MANAGED]: '1',
      [LABEL_WORKSPACE]: workspaceId,
    });
    const handle = await this.engine.createContainer(spec);
    await this.engine.startContainer(handle.id);

    const record: SandboxRecord = {
      workspaceId,
      team,
      project,
      branch,
      baseRef,
      upstream,
      repo,
      containerId: handle.id,
      status: 'running',
      bootstrapToken,
      ...(devPort !== undefined ? { devPort } : {}),
    };
    this.registry.upsert(record);
    this.lastActiveAt.set(workspaceId, Date.now());
    await this.credentials.watch(workspaceId);
    return record;
  }

  /**
   * Verify the mounted daemon build actually contains its entry file before spawning any sandbox.
   * Throws a clear "run `pnpm daemon:build`" error otherwise (the daemon is mounted from `buildVolume`,
   * not baked into the image). Cached: only the FIRST `create` pays the throwaway-container check.
   */
  private async ensureBuildPresent(
    image: string,
    buildVolume: string,
  ): Promise<void> {
    if (this.buildChecked) return;
    const present = await this.engine.daemonBuildPresent(
      buildVolume,
      image,
      DAEMON_ENTRY,
    );
    if (!present) {
      throw new Error(
        `Daemon build not found in volume "${buildVolume}" (missing ${DAEMON_ENTRY}). ` +
          'Run `pnpm daemon:build` to (re)populate it before spawning sandboxes.',
      );
    }
    this.buildChecked = true;
  }

  /** Stop + remove a sandbox container AND its inner-docker storage volume. Idempotent: an unknown/gone
   * workspace is a no-op. Removing the ~GiB `/var/lib/docker` volume is the disk-leak fix — a container
   * removed without it leaves its volume behind (the ENOSPC root cause). */
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
      // Reclaim the inner-docker volume now the container holding it is gone (best-effort).
      await this.engine
        .removeVolume(dockerStorageVolume(workspaceId))
        .catch((err) =>
          this.logger.warn(
            `remove volume for ${workspaceId} failed: ${String(err)}`,
          ),
        );
      await this.credentials.unwatch(workspaceId);
      // Drop any cached readiness — a recreated sandbox gets a fresh uuid, but clearing keeps the
      // gate's cache honest and bounded (no entries linger for destroyed workspaces).
      this.readiness.forget(workspaceId);
      this.lastActiveAt.delete(workspaceId);
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
    // After the registry is rebuilt from live containers, reclaim any managed inner-docker volume whose
    // sandbox is gone (the disk-leak fix — orphaned ~GiB volumes accumulate otherwise).
    await this.sweepOrphanVolumes().catch((err) =>
      this.logger.warn(
        `orphan-volume sweep skipped: ${err instanceof Error ? err.message : err}`,
      ),
    );
    // Bring every running sandbox to the CURRENT daemon build: a sandbox that survived a slack-app restart
    // (restartPolicy: unless-stopped) still runs the OLD daemon it `exec`'d at create time, so after a
    // daemon code change it's version-skewed against the host's new RPC contract. This restarts the stale
    // ones onto the freshly-built daemon (the volume is already rebuilt by provisioning above). Ordered
    // LAST so the build is current before any restart; resilient (a Docker-absent host just logs + skips).
    await this.reconcileDaemonVersions().catch((err) =>
      this.logger.warn(
        `daemon-version reconciliation skipped: ${err instanceof Error ? err.message : err}`,
      ),
    );
    // Start the periodic idle reaper (per-branch workstations accumulate; a clean+idle+session-less one
    // past its TTL is reaped — never an unsafe one). Guarded setInterval, unref'd so it never holds the
    // process open; cleared on shutdown. Mirrors ReferenceLibraryService's sweep timer.
    this.reapTimer = setInterval(() => {
      void this.reapIdleWorkstations().catch((err) =>
        this.logger.warn(
          `idle-reaper sweep failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
    }, REAP_SWEEP_INTERVAL_MS);
    this.reapTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.reapTimer) clearInterval(this.reapTimer);
  }

  /** Remove managed inner-docker volumes (label `com.agent.managed=1`) with no live sandbox in the
   * registry. Mirrors `reconcile()` (containers) for volumes; runs once at boot after reconcile, so the
   * registry is authoritative. The daemon-build + pnpm-store volumes are unlabelled, so never swept. */
  private async sweepOrphanVolumes(): Promise<void> {
    await this.ops(async () => {
      const vols = await this.engine.listVolumes({
        label: [`${LABEL_MANAGED}=1`],
      });
      for (const v of vols) {
        const wsId = v.labels[LABEL_WORKSPACE];
        if (wsId && this.registry.get(wsId)) continue; // a live sandbox still owns it
        this.logger.log(`sweeping orphan volume ${v.name} (no live sandbox)`);
        await this.engine
          .removeVolume(v.name)
          .catch((err) =>
            this.logger.warn(`sweep ${v.name} failed: ${String(err)}`),
          );
      }
    });
  }

  /**
   * BOOT-TIME DAEMON-VERSION RECONCILIATION. The slack-app rebuilds the daemon volume on every boot (so
   * NEWLY-created sandboxes mount the current daemon), but a sandbox that survived this restart
   * (`restartPolicy: unless-stopped`) still runs the OLD daemon process it `exec`'d at ITS create time —
   * version-skewed against the host's new RPC contract after a daemon code change. The only durable,
   * idempotent fix is content-based + self-reported: each running daemon reports its actual build version
   * (`version()` — `sha256(main.js)` read from its mount), we compare against the CURRENT (just-built)
   * volume version, and `docker restart` (NEVER recreate — the in-container clone holds unpushed work) any
   * that differ. A restarted daemon re-`exec`s the new `main.js` and naturally reports the new version, so
   * this converges and is a no-op once everything is current.
   *
   * Restart-vs-skip, per running managed sandbox:
   *   - `version()` RPC THROWS (old daemon with no such RPC, or unreachable) ⇒ definitely stale ⇒ RESTART;
   *   - reported version ≠ current ⇒ RESTART;
   *   - reported version === current ⇒ SKIP (already current — the idempotent no-op).
   * A restart FAILURE is logged and the sweep CONTINUES (one bad container never aborts the rest). If the
   * host can't determine the CURRENT version (no `WORKSPACE_IMAGE`, or the build predates the `.build-version`
   * stamp), the whole sweep is SKIPPED — we won't bounce running sandboxes without a target to compare to.
   *
   * Only RUNNING sandboxes are candidates (a stopped one will `exec` the current daemon when it next starts).
   * Snapshots the registry up front (post-`reconcile`), so a sandbox created concurrently isn't double-handled.
   */
  async reconcileDaemonVersions(): Promise<void> {
    const current = await this.provisioner.currentBuildVersion();
    if (!current) {
      this.logger.debug(
        'daemon-version reconciliation: no current build version available — skipping (running sandboxes left as-is).',
      );
      return;
    }
    const running = this.registry.list().filter((r) => r.status === 'running');
    for (const rec of running) {
      const id = rec.workspaceId;
      let reported: string | undefined;
      try {
        const res = (await this.daemon.gitCall(id, 'version', [])) as {
          buildVersion?: string;
        };
        reported = res?.buildVersion;
      } catch (err) {
        // An old daemon has no `version()` RPC (the call errors) ⇒ definitely stale ⇒ restart it.
        this.logger.log(
          `daemon-version: ${id} (${rec.team}/${rec.project} ${rec.branch}) — version() failed ` +
            `(${err instanceof Error ? err.message : String(err)}); treating as STALE and restarting onto ${current}.`,
        );
        await this.restartStale(id, rec);
        continue;
      }
      if (reported === current) {
        this.logger.debug(
          `daemon-version: ${id} already on current build ${current} — skipping.`,
        );
        continue;
      }
      this.logger.log(
        `daemon-version: ${id} (${rec.team}/${rec.project} ${rec.branch}) on ` +
          `${reported || '(unreported)'} ≠ current ${current} — restarting onto the new daemon.`,
      );
      await this.restartStale(id, rec);
    }
  }

  /** Restart ONE stale sandbox onto the current daemon — `docker restart` (NEVER recreate; the clone in the
   * writable layer must survive). A restart failure is logged and swallowed so the sweep continues. */
  private async restartStale(id: string, rec: SandboxRecord): Promise<void> {
    await this.engine.restartContainer(rec.containerId).catch((err) =>
      this.logger.warn(
        `daemon-version: restart of ${id} (${rec.containerId}) failed: ${String(err)} — leaving it; ` +
          'it will be retried next boot.',
      ),
    );
  }

  /**
   * THE IDLE REAPER. Per-branch workstations accumulate (one container per branch), so a periodic sweep
   * reclaims the ones that are demonstrably done with. A branch-scoped workstation is reaped (via
   * `destroyWorkspace`) ONLY when ALL of these hold:
   *   (a) it has NO open (non-closed) sessions — the open-sessions probe reports 0;
   *   (b) it's idle past the TTL — `now - lastActiveAt > idleTtlMs`;
   *   (c) the daemon reports it REAP-SAFE — `aheadOfOrigin === 0 && !dirty` (no unpushed commits, no
   *       uncommitted changes). The clone lives in the container's writable layer, so reaping DESTROYS it
   *       — getting (c) wrong loses work.
   * If the daemon is UNREACHABLE or reports UNSAFE, the workstation is SKIPPED and logged (never reaped on
   * doubt). Legacy no-branch sandboxes are left alone (the workstation model is per-branch). Every reap and
   * every skip-because-unsafe is logged.
   *
   * NOT under the ops mutex at the top level (a daemon `syncStatus` round-trip can be slow and the mutex
   * also serializes create/find); only the actual `destroyWorkspace` it calls takes the mutex. We snapshot
   * the registry up front, so a workstation created mid-sweep is simply considered next cycle.
   */
  async reapIdleWorkstations(): Promise<void> {
    const ttl = this.idleTtlMs();
    const now = Date.now();
    const candidates = this.registry
      .list()
      .filter((r) => !!r.branch && r.status !== 'gone');

    for (const rec of candidates) {
      const id = rec.workspaceId;
      // (b) idle past the TTL? A missing stamp defaults to "now" (not idle) so we never reap an
      // un-stamped, possibly-active workstation.
      const lastActive = this.lastActiveAt.get(id) ?? now;
      if (now - lastActive <= ttl) continue;

      // (a) no open sessions? Until the probe is bound, conservatively assume it HAS open work (skip).
      const openCount = this.openSessionsProbe
        ? await this.openSessionsProbe(id).catch(() => 1)
        : 1;
      if (openCount > 0) continue;

      // (c) daemon reports reap-safe? Any unreachable/unsafe result → SKIP + log (never reap on doubt).
      let safe = false;
      try {
        const status = (await this.daemon.gitCall(id, 'syncStatus', [])) as {
          aheadOfOrigin: number;
          dirty: boolean;
        };
        safe = status.aheadOfOrigin === 0 && !status.dirty;
        if (!safe) {
          this.logger.log(
            `idle-reaper: SKIP ${id} (${rec.team}/${rec.project} ${rec.branch}) — not reap-safe ` +
              `(aheadOfOrigin=${status.aheadOfOrigin}, dirty=${status.dirty}); leaving it.`,
          );
          continue;
        }
      } catch (err) {
        this.logger.log(
          `idle-reaper: SKIP ${id} (${rec.team}/${rec.project} ${rec.branch}) — daemon unreachable ` +
            `for reap-safety check (${err instanceof Error ? err.message : String(err)}); leaving it.`,
        );
        continue;
      }

      this.logger.log(
        `idle-reaper: reaping ${id} (${rec.team}/${rec.project} ${rec.branch}) — no open sessions, ` +
          `idle ${Math.round((now - lastActive) / 60000)}m past TTL, reap-safe.`,
      );
      await this.destroyWorkspace(id).catch((err) =>
        this.logger.warn(`idle-reaper: reap of ${id} failed: ${String(err)}`),
      );
    }
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
        // The bootstrap token now SURVIVES a restart (persisted as `com.agent.boot-token`; `toRecord`
        // recovered it), so an adopted sandbox can serve the cred-channel without being recreated. A
        // sandbox created before this label existed (or with the label stripped) still adopts WITHOUT a
        // token — its cred-req then gets a clean rejection (not silence) until recreate.
        this.registry.upsert(record);
        // Recover the durable last-activity stamp so a re-adopted workstation keeps its age across a
        // restart. A missing/garbage label → seed "now" (treat as freshly active, so the reaper is
        // patient and never reaps a just-adopted workstation on its first sweep).
        const stamp = Number.parseInt(c.labels[LABEL_LAST_ACTIVE] ?? '', 10);
        this.lastActiveAt.set(
          record.workspaceId,
          Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now(),
        );
        await this.credentials.watch(record.workspaceId);
        this.logger.log(
          `adopted sandbox ${record.workspaceId} (${record.team}/${record.project}, ${record.status})`,
        );
      }
    });
  }

  /** Parse a managed container's labels into a registry record (boot reconcile + find share this). The
   * bootstrap token is recovered from its label so a RE-ADOPTED sandbox can still serve the cred-pull. */
  private toRecord(c: ContainerSummary): SandboxRecord {
    const bootstrapToken = c.labels[LABEL_BOOT_TOKEN];
    // The published dev-server host port, recovered from the label so the URL reconciles on boot (and the
    // allocator continues to treat it as taken). Absent on a sandbox that predates this feature.
    const devPortRaw = Number.parseInt(c.labels[LABEL_DEV_PORT] ?? '', 10);
    return {
      workspaceId: c.labels[LABEL_WORKSPACE] ?? '',
      team: c.labels[LABEL_TEAM] ?? '',
      project: c.labels[LABEL_PROJECT] ?? '',
      // The per-branch identity, recovered from labels so a re-adopted workstation keeps its branch key
      // (and the refs the daemon needs to create/PR it). '' on a sandbox that predates these labels.
      branch: c.labels[LABEL_BRANCH] ?? '',
      baseRef: c.labels[LABEL_BASE_REF] ?? '',
      upstream: c.labels[LABEL_UPSTREAM] ?? '',
      repo: c.labels[LABEL_REPO] ?? '',
      containerId: c.id,
      status: toStatus(c.state),
      ...(bootstrapToken ? { bootstrapToken } : {}),
      ...(Number.isFinite(devPortRaw) ? { devPort: devPortRaw } : {}),
    };
  }

  /** The project's registered repo coordinates: the GitHub URL (for the `com.agent.repo` label AND the
   * daemon's clone-on-boot `WORKSPACE_REPO_URL`) + the PR base branch (`WORKSPACE_BASE_BRANCH`, default
   * `main`). Empty/default when the project isn't registered — Phase 9 only containerizes registered
   * projects, but this stays tolerant. */
  private async repoCoordinates(
    team: string,
    project: string,
  ): Promise<{ gitUrl: string; baseBranch: string }> {
    const rec = await this.projects.get(team, project).catch(() => undefined);
    return {
      gitUrl: rec?.gitUrl ?? '',
      baseBranch: rec?.defaultBranch ?? 'main',
    };
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
