/**
 * Phase 6 host sandbox-lifecycle unit tests — `ContainerManagerService` against the in-memory container
 * engine fake (NO Docker socket). Covers:
 *   (a) `ensureWorkspace` create-then-find idempotency + the exact create spec (managed labels,
 *       privileged, NO host ports, env carrying REDIS_URL/WORKSPACE_ID/DAEMON_BOOTSTRAP_TOKEN, limits);
 *   (b) boot reconciliation rebuilds the registry from labelled containers.
 * `ProjectStore`/`EnvService`/`CredentialProvisionerService` are mocked.
 */
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { ProjectStore } from '../projects/project-store';
import { ContainerManagerService } from './container-manager.service';
import type { CredentialProvisionerService } from './credential-provisioner.service';
import type { DaemonClient } from './daemon-client';
import { InMemoryContainerEngine } from './in-memory-container-engine';
import type { SandboxReadinessService } from './sandbox-readiness.service';
import { SandboxRegistry } from './sandbox-registry';
import type { WorkspaceProvisionerService } from './workspace-provisioner.service';
import type { ReferenceLibraryService } from './reference-library.service';

const TEAM = 'team-1';
const PROJECT = 'proj-1';
const REPO = 'https://github.com/acme/proj-1';
const BRANCH = 'feature/export-csv';
const BASE_REF = 'dev';
const UPSTREAM = 'dev';

/** ensureWorkspace's new per-branch signature — the tests pin one workstation `(team, project, branch)`. */
function ensure(
  manager: ContainerManagerService,
  team = TEAM,
  project = PROJECT,
  branch = BRANCH,
) {
  return manager.ensureWorkspace(team, project, branch, BASE_REF, UPSTREAM);
}

function makeEnv(over: Record<string, string> = {}): EnvService {
  const values: Record<string, string | undefined> = {
    WORKSPACE_IMAGE: 'agent-workspace-base:pinned',
    REDIS_URL: 'redis://redis-host:6379',
    ...over,
  };
  return { get: (k: string) => values[k] } as unknown as EnvService;
}

function makeProjects(): ProjectStore {
  return {
    get: vi.fn(async (team: string, project: string) =>
      team === TEAM && project === PROJECT
        ? { teamId: TEAM, projectId: PROJECT, gitUrl: REPO }
        : undefined,
    ),
  } as unknown as ProjectStore;
}

function makeCredentials(): CredentialProvisionerService {
  return {
    watch: vi.fn(async () => undefined),
    unwatch: vi.fn(async () => undefined),
  } as unknown as CredentialProvisionerService;
}

function makeReadiness(): SandboxReadinessService {
  return {
    waitForReady: vi.fn(async () => undefined),
    forget: vi.fn(),
  } as unknown as SandboxReadinessService;
}

/** A no-op provisioner — the manager-level tests isolate from boot provisioning (its real behavior is
 * covered in workspace-provisioner.service.spec.ts). `ensureProvisioned` just resolves. `currentBuildVersion`
 * defaults to undefined (no build version known → boot version-reconciliation SKIPS, the safe default that
 * leaves running sandboxes untouched); the version-reconciliation tests override it with a real version. */
function makeProvisioner(
  currentBuildVersion: string | undefined = undefined,
): WorkspaceProvisionerService {
  return {
    ensureProvisioned: vi.fn(async () => undefined),
    currentBuildVersion: vi.fn(async () => currentBuildVersion),
  } as unknown as WorkspaceProvisionerService;
}

/** A reference library that just hands back a deterministic host mount source per team. */
function makeRefs(): ReferenceLibraryService {
  return {
    ensureTeamMountSource: vi.fn(async (team: string) => `/host/refs/${team}`),
  } as unknown as ReferenceLibraryService;
}

/** A fake DaemonClient whose `gitCall` is the reap-safety probe seam (`syncStatus`). Default: reap-safe
 * (no unpushed commits, clean tree). Tests override `gitCall` to simulate unsafe / unreachable daemons. */
function makeDaemon(
  syncStatus: { aheadOfOrigin: number; dirty: boolean } = {
    aheadOfOrigin: 0,
    dirty: false,
  },
): DaemonClient & { gitCall: ReturnType<typeof vi.fn> } {
  const gitCall = vi.fn(async (_id: string, method: string) => {
    if (method === 'syncStatus') return syncStatus;
    return undefined;
  });
  return { gitCall } as unknown as DaemonClient & {
    gitCall: ReturnType<typeof vi.fn>;
  };
}

describe('ContainerManagerService (in-memory container engine)', () => {
  let engine: InMemoryContainerEngine;
  let registry: SandboxRegistry;
  let credentials: CredentialProvisionerService;
  let readiness: SandboxReadinessService;
  let provisioner: WorkspaceProvisionerService;
  let daemon: DaemonClient & { gitCall: ReturnType<typeof vi.fn> };
  let manager: ContainerManagerService;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    engine = new InMemoryContainerEngine();
    registry = new SandboxRegistry();
    credentials = makeCredentials();
    readiness = makeReadiness();
    provisioner = makeProvisioner();
    daemon = makeDaemon();
    manager = new ContainerManagerService(
      engine,
      makeEnv(),
      makeProjects(),
      registry,
      credentials,
      readiness,
      provisioner,
      makeRefs(),
      daemon,
    );
  });

  afterEach(() => {
    // Clear the (unref'd) idle-reaper interval any onApplicationBootstrap call started.
    manager.onModuleDestroy();
  });

  it('(a) ensureWorkspace creates a sandbox with the correct spec', async () => {
    const rec = await ensure(manager);

    expect(engine.created).toHaveLength(1);
    const spec = engine.created[0];

    // uuid name, sanitized
    expect(spec.name).toMatch(/^agent-ws-[0-9a-f-]{36}$/);
    expect(spec.image).toBe('agent-workspace-base:pinned');

    // privileged DinD, restart policy, runtime default
    expect(spec.privileged).toBe(true);
    expect(spec.restartPolicy).toBe('unless-stopped');
    expect(spec.runtime).toBe('runc');

    // managed labels — incl. the per-branch identity (branch/baseRef/upstream survive a restart).
    expect(spec.labels).toMatchObject({
      'com.agent.managed': '1',
      'com.agent.workspace': rec.workspaceId,
      'com.agent.team': TEAM,
      'com.agent.project': PROJECT,
      'com.agent.repo': REPO,
      'com.agent.branch': BRANCH,
      'com.agent.base-ref': BASE_REF,
      'com.agent.upstream': UPSTREAM,
    });
    // the record carries the per-branch identity back
    expect(rec.branch).toBe(BRANCH);
    expect(rec.baseRef).toBe(BASE_REF);
    expect(rec.upstream).toBe(UPSTREAM);

    // env: the SANDBOX-reachable Redis URL (WORKSPACE_REDIS_URL default, NOT the host's REDIS_URL) +
    // WORKSPACE_ID + a short random DAEMON_BOOTSTRAP_TOKEN; NO secrets baked in.
    expect(spec.env).toContain('REDIS_URL=redis://agent-playground-redis:6379');
    expect(spec.env).toContain(`WORKSPACE_ID=${rec.workspaceId}`);
    const tokenEnv = spec.env.find((e) =>
      e.startsWith('DAEMON_BOOTSTRAP_TOKEN='),
    );
    expect(tokenEnv).toBeDefined();
    expect(tokenEnv!.slice('DAEMON_BOOTSTRAP_TOKEN='.length).length).toBeGreaterThanOrEqual(
      32,
    );

    // Phase 11: the clone-on-boot repo coordinates (from ProjectStore) + the joined network are injected.
    expect(spec.env).toContain(`WORKSPACE_REPO_URL=${REPO}`);
    expect(spec.env).toContain('WORKSPACE_BASE_BRANCH=main'); // ProjectRecord has no defaultBranch → default
    // Workstations: the per-branch checkout env the daemon reads at boot to check out / cut the branch.
    expect(spec.env).toContain(`WORKSPACE_BRANCH=${BRANCH}`);
    expect(spec.env).toContain(`WORKSPACE_BASE_REF=${BASE_REF}`);
    expect(spec.env).toContain(`WORKSPACE_UPSTREAM=${UPSTREAM}`);
    expect(spec.network).toBe('agent-playground_default');
    // Storage driver NOT injected when WORKSPACE_DOCKER_STORAGE_DRIVER is unset (entrypoint auto-detects).
    expect(spec.env.some((e) => e.startsWith('DOCKERD_STORAGE_DRIVER='))).toBe(
      false,
    );

    // per-sandbox docker-storage volume mount for the inner DinD
    expect(spec.binds).toContain(
      `agent-ws-docker-${rec.workspaceId}:/var/lib/docker`,
    );
    // the Linux daemon build is MOUNTED read-only at /daemon (not baked into the image)
    expect(spec.binds).toContain('agent-daemon-build:/daemon:ro');
    // the team's shared reference library is mounted READ-ONLY at /refs (team-scoped host source)
    expect(spec.binds).toContain(`/host/refs/${TEAM}:/refs:ro`);
    // that docker-storage volume is explicitly created + labelled (so the boot sweep can find leaks)
    expect(engine.createdVolumes).toContain(`agent-ws-docker-${rec.workspaceId}`);

    // host-injected runtime env that the GENERIC image no longer bakes — incl. the mounted-daemon entry,
    // the in-sandbox roots, and the relaxed-guard signal. Deliberately NO NODE_ENV=production.
    expect(spec.env).toContain(
      'DAEMON_ENTRY=/daemon/backend/dist/daemon/main.js',
    );
    // The harness source root inside the sandbox = the daemon mount (anchors repo-local skill paths;
    // the volume has no `.git` so `git rev-parse` can't find it).
    expect(spec.env).toContain('HARNESS_ROOT=/daemon');
    expect(spec.env).toContain('AGENT_HOME_ROOT=/workspace/.agent-home');
    expect(spec.env).toContain('WORKSPACE_ROOT=/workspace/repo');
    expect(spec.env).toContain('SANDBOX_GUARD_RELAXED=true');
    expect(spec.env.some((e) => e.startsWith('NODE_ENV='))).toBe(false);

    // resource limits set
    expect(spec.memoryBytes).toBeGreaterThan(0);
    expect(spec.nanoCpus).toBeGreaterThan(0);
    expect(spec.pidsLimit).toBeGreaterThan(0);

    // Phase 2: the SINGLE localhost-only published dev-server port — the container's WORKSPACE_DEV_PORT
    // (7000 default) → an allocated host port bound to 127.0.0.1 (never 0.0.0.0). First create takes the
    // bottom of the pool (39000).
    expect(spec.ports).toEqual([
      { hostIp: '127.0.0.1', hostPort: 39000, containerPort: 7000 },
    ]);
    // The allocated host port is stamped as the durable `com.agent.devport` label (the allocator's
    // source of truth) AND carried on the record (so the URL surfaces + reconciles on boot).
    expect(spec.labels['com.agent.devport']).toBe('39000');
    expect(rec.devPort).toBe(39000);

    // started + registered + cred channel watched
    expect(rec.status).toBe('running');
    expect(registry.get(rec.workspaceId)).toEqual(rec);
    expect(credentials.watch).toHaveBeenCalledWith(rec.workspaceId);
  });

  it('(a) ensureWorkspace is idempotent for the SAME branch — a second call finds, never re-creates', async () => {
    const first = await ensure(manager);
    const second = await ensure(manager);

    expect(engine.created).toHaveLength(1); // only ONE container ever created
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.containerId).toBe(first.containerId);
    // The found path preserves the in-process bootstrap token.
    expect(second.bootstrapToken).toBe(first.bootstrapToken);
  });

  it('(a) a DIFFERENT branch of the same project is a DIFFERENT workstation (per-branch identity)', async () => {
    const feat = await ensure(manager, TEAM, PROJECT, 'feature/a');
    const hotfix = await ensure(manager, TEAM, PROJECT, 'hotfix/b');

    // Two distinct sandboxes — the branch label keeps them apart (findRunning filters on it).
    expect(engine.created).toHaveLength(2);
    expect(hotfix.workspaceId).not.toBe(feat.workspaceId);
    expect(feat.branch).toBe('feature/a');
    expect(hotfix.branch).toBe('hotfix/b');
  });

  it('(a) resolveForSession lazily ensures via the bound ensurer (per-branch scope)', async () => {
    const rec = await registry.resolveForSession({
      team: TEAM,
      project: PROJECT,
      branch: BRANCH,
      baseRef: BASE_REF,
      upstream: UPSTREAM,
    });
    expect(engine.created).toHaveLength(1);
    expect(rec.team).toBe(TEAM);
    expect(rec.branch).toBe(BRANCH);
    // A second resolve for the same branch reuses the same sandbox (no new container).
    const again = await registry.resolveForSession({
      team: TEAM,
      project: PROJECT,
      branch: BRANCH,
    });
    expect(again.workspaceId).toBe(rec.workspaceId);
    expect(engine.created).toHaveLength(1);
  });

  it('ensureWorkspace throws a clear error when WORKSPACE_IMAGE is unset', async () => {
    manager = new ContainerManagerService(
      engine,
      makeEnv({ WORKSPACE_IMAGE: undefined as unknown as string }),
      makeProjects(),
      registry,
      credentials,
      readiness,
      provisioner,
      makeRefs(),
      daemon,
    );
    await expect(ensure(manager)).rejects.toThrow(
      /WORKSPACE_IMAGE is not set/,
    );
    expect(engine.created).toHaveLength(0);
  });

  it('WORKSPACE_RUNTIME overrides the default runtime (sysbox switch reserved)', async () => {
    manager = new ContainerManagerService(
      engine,
      makeEnv({ WORKSPACE_RUNTIME: 'sysbox-runc' }),
      makeProjects(),
      registry,
      credentials,
      readiness,
      provisioner,
      makeRefs(),
      daemon,
    );
    await ensure(manager);
    expect(engine.created[0].runtime).toBe('sysbox-runc');
  });

  it('(Phase 11) WORKSPACE_REDIS_URL / WORKSPACE_NETWORK / WORKSPACE_DOCKER_STORAGE_DRIVER override the defaults', async () => {
    manager = new ContainerManagerService(
      engine,
      makeEnv({
        WORKSPACE_REDIS_URL: 'redis://custom-redis:6399',
        WORKSPACE_NETWORK: 'my-net',
        WORKSPACE_DOCKER_STORAGE_DRIVER: 'vfs',
      }),
      makeProjects(),
      registry,
      credentials,
      readiness,
      provisioner,
      makeRefs(),
      daemon,
    );
    await ensure(manager);
    const spec = engine.created[0];
    expect(spec.env).toContain('REDIS_URL=redis://custom-redis:6399');
    expect(spec.network).toBe('my-net');
    expect(spec.env).toContain('DOCKERD_STORAGE_DRIVER=vfs');
  });

  it('(b) boot reconciliation rebuilds the registry from labelled containers', async () => {
    // Simulate two managed sandboxes already running on the host (separate process history) plus an
    // unrelated container that must be ignored.
    const wsIdA = 'uuid-aaaa';
    const wsIdB = 'uuid-bbbb';
    engine.seed(
      {
        name: `agent-ws-${wsIdA}`,
        image: 'img',
        env: [],
        labels: {
          'com.agent.managed': '1',
          'com.agent.workspace': wsIdA,
          'com.agent.team': TEAM,
          'com.agent.project': PROJECT,
          'com.agent.repo': REPO,
          'com.agent.branch': BRANCH,
          'com.agent.base-ref': BASE_REF,
          'com.agent.upstream': UPSTREAM,
        },
        privileged: true,
        binds: [],
        restartPolicy: 'unless-stopped',
      },
      'running',
    );
    engine.seed(
      {
        name: `agent-ws-${wsIdB}`,
        image: 'img',
        env: [],
        labels: {
          'com.agent.managed': '1',
          'com.agent.workspace': wsIdB,
          'com.agent.team': 'team-2',
          'com.agent.project': 'proj-2',
          'com.agent.repo': 'https://github.com/acme/proj-2',
          'com.agent.branch': 'hotfix/x',
        },
        privileged: true,
        binds: [],
        restartPolicy: 'unless-stopped',
      },
      'exited',
    );
    engine.seed(
      {
        name: 'some-other-container',
        image: 'postgres',
        env: [],
        labels: { app: 'postgres' },
        privileged: false,
        binds: [],
        restartPolicy: 'no',
      },
      'running',
    );

    await manager.onApplicationBootstrap();

    const list = registry.list();
    expect(list).toHaveLength(2); // only the two managed sandboxes

    const a = registry.get(wsIdA);
    expect(a).toMatchObject({
      workspaceId: wsIdA,
      team: TEAM,
      project: PROJECT,
      repo: REPO,
      status: 'running',
      // the per-branch identity is recovered from labels on adoption
      branch: BRANCH,
      baseRef: BASE_REF,
      upstream: UPSTREAM,
    });
    const b = registry.get(wsIdB);
    expect(b).toMatchObject({
      workspaceId: wsIdB,
      team: 'team-2',
      project: 'proj-2',
      status: 'stopped', // exited → stopped
    });

    // These fixtures predate the `com.agent.boot-token` label, so they adopt WITHOUT a token — but ARE
    // watched for clean rejection. (A container created with the label recovers its token; see below.)
    expect(a!.bootstrapToken).toBeUndefined();
    expect(credentials.watch).toHaveBeenCalledWith(wsIdA);
    expect(credentials.watch).toHaveBeenCalledWith(wsIdB);

    // find() resolves the existing workstation by (team, project, branch) without a new container.
    const found = registry.find({ team: TEAM, project: PROJECT, branch: BRANCH });
    expect(found?.workspaceId).toBe(wsIdA);
  });

  it('(e) create persists the bootstrap token as the com.agent.boot-token label', async () => {
    const rec = await ensure(manager);
    const spec = engine.created[0];
    expect(spec.labels['com.agent.boot-token']).toBe(rec.bootstrapToken);
    expect(rec.bootstrapToken).toBeDefined();
  });

  it('(e) a re-adopted sandbox RECOVERS its bootstrap token from the label (survives restart)', async () => {
    const wsId = 'uuid-tok';
    engine.seed(
      {
        name: `agent-ws-${wsId}`,
        image: 'img',
        env: [],
        labels: {
          'com.agent.managed': '1',
          'com.agent.workspace': wsId,
          'com.agent.team': TEAM,
          'com.agent.project': PROJECT,
          'com.agent.repo': REPO,
          'com.agent.branch': BRANCH,
          'com.agent.boot-token': 'persisted-token-123',
        },
        privileged: true,
        binds: [],
        restartPolicy: 'unless-stopped',
      },
      'running',
    );
    // Fresh process: a registry that never issued this token still recovers it from the label on reconcile,
    // so the sandbox can keep serving the cred-pull without being recreated.
    await manager.onApplicationBootstrap();
    expect(registry.get(wsId)?.bootstrapToken).toBe('persisted-token-123');
    // findRunning (the ensureWorkspace fast path) recovers it too.
    const found = await ensure(manager);
    expect(found.workspaceId).toBe(wsId);
    expect(found.bootstrapToken).toBe('persisted-token-123');
  });

  it('destroyWorkspace stops + removes the container AND its inner-docker volume, unwatches creds, clears readiness', async () => {
    const rec = await ensure(manager);
    await manager.destroyWorkspace(rec.workspaceId);

    expect(engine.removed).toContain(rec.containerId);
    // The disk-leak fix: the ~GiB /var/lib/docker volume is reclaimed too.
    expect(engine.removedVolumes).toContain(`agent-ws-docker-${rec.workspaceId}`);
    expect(registry.get(rec.workspaceId)).toBeUndefined();
    expect(credentials.unwatch).toHaveBeenCalledWith(rec.workspaceId);
    expect(readiness.forget).toHaveBeenCalledWith(rec.workspaceId);
  });

  it('ensureWorkspace fails loudly when the daemon build is missing from the volume', async () => {
    engine.buildPresent = false; // simulate a volume that exists but has no dist/daemon/main.js
    await expect(ensure(manager)).rejects.toThrow(
      /pnpm daemon:build/,
    );
    expect(engine.created).toHaveLength(0); // never spawned the container
  });

  it('create awaits the boot provisioner before spawning (self-provision wiring)', async () => {
    await ensure(manager);
    expect(provisioner.ensureProvisioned).toHaveBeenCalledTimes(1);
    expect(engine.created).toHaveLength(1);
  });

  it('a provisioner failure aborts the spawn (no half-built sandbox)', async () => {
    (provisioner.ensureProvisioned as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('docker build failed'),
    );
    await expect(ensure(manager)).rejects.toThrow(
      /docker build failed/,
    );
    expect(engine.created).toHaveLength(0);
  });

  it('boot sweep reclaims a managed inner-docker volume with no live sandbox, but keeps live ones', async () => {
    // A leaked volume (no container) + a volume owned by a live sandbox.
    engine.seedVolume('agent-ws-docker-orphan', {
      'com.agent.managed': '1',
      'com.agent.workspace': 'orphan',
    });
    const rec = await ensure(manager); // creates a live sandbox + its volume

    await manager.onApplicationBootstrap();

    expect(engine.removedVolumes).toContain('agent-ws-docker-orphan');
    // the live sandbox's volume is NOT swept
    expect(engine.removedVolumes).not.toContain(
      `agent-ws-docker-${rec.workspaceId}`,
    );
  });

  it('reconciliation is resilient to a Docker-absent host (no throw)', async () => {
    const failing = {
      listContainers: vi.fn(async () => {
        throw new Error('connect ENOENT /var/run/docker.sock');
      }),
    } as unknown as InMemoryContainerEngine;
    manager = new ContainerManagerService(
      failing,
      makeEnv(),
      makeProjects(),
      registry,
      credentials,
      readiness,
      provisioner,
      makeRefs(),
      daemon,
    );
    await expect(manager.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });

  // ── Phase 3: per-(team,project) create CAP ──────────────────────────────────────────────────────

  describe('per-(team,project) create cap', () => {
    function withCap(cap: number) {
      const m = new ContainerManagerService(
        engine,
        makeEnv({ WORKSPACE_MAX_PER_PROJECT: String(cap) }),
        makeProjects(),
        registry,
        credentials,
        readiness,
        provisioner,
        makeRefs(),
        daemon,
      );
      return m;
    }

    it('allows creates UNDER the cap, then REFUSES the one that would exceed it', async () => {
      const m = withCap(2);
      const a = await m.ensureWorkspace(TEAM, PROJECT, 'feature/a', BASE_REF, UPSTREAM);
      const b = await m.ensureWorkspace(TEAM, PROJECT, 'feature/b', BASE_REF, UPSTREAM);
      expect(a.workspaceId).toBeDefined();
      expect(b.workspaceId).toBeDefined();
      expect(engine.created).toHaveLength(2);

      // The third DISTINCT branch trips the cap — a clear, actionable refusal; no container created.
      await expect(
        m.ensureWorkspace(TEAM, PROJECT, 'feature/c', BASE_REF, UPSTREAM),
      ).rejects.toThrow(/2 workstations for this project \(cap 2\).*remove_workspace/is);
      expect(engine.created).toHaveLength(2);
    });

    it('re-entering an EXISTING branch never trips the cap (idempotent, no new container)', async () => {
      const m = withCap(1);
      await m.ensureWorkspace(TEAM, PROJECT, 'feature/a', BASE_REF, UPSTREAM);
      // Re-entry of the SAME branch finds the existing one — even at cap 1.
      const again = await m.ensureWorkspace(TEAM, PROJECT, 'feature/a', BASE_REF, UPSTREAM);
      expect(again.branch).toBe('feature/a');
      expect(engine.created).toHaveLength(1);
    });

    it('the cap is per (team, project) — a different project is independent', async () => {
      const m = withCap(1);
      await m.ensureWorkspace(TEAM, PROJECT, 'feature/a', BASE_REF, UPSTREAM);
      // A different project still has headroom.
      const other = await m.ensureWorkspace(TEAM, 'proj-2', 'feature/a', BASE_REF, UPSTREAM);
      expect(other.project).toBe('proj-2');
      expect(engine.created).toHaveLength(2);
    });
  });

  // ── Phase 3: idle REAPER ────────────────────────────────────────────────────────────────────────

  describe('idle reaper', () => {
    const TTL_MIN = 60; // 1h TTL for the tests
    const PAST_TTL_MS = (TTL_MIN + 1) * 60 * 1000;

    /** A manager whose open-sessions probe + daemon syncStatus are controllable per test. */
    function reaperManager(opts: {
      openSessions?: (id: string) => Promise<number>;
      syncStatus?: { aheadOfOrigin: number; dirty: boolean };
      syncThrows?: boolean;
    }) {
      const d = makeDaemon(opts.syncStatus);
      if (opts.syncThrows) {
        d.gitCall.mockImplementation(async () => {
          throw new Error('daemon unreachable');
        });
      }
      const m = new ContainerManagerService(
        engine,
        makeEnv({ WORKSPACE_IDLE_TTL_MINUTES: String(TTL_MIN) }),
        makeProjects(),
        registry,
        credentials,
        readiness,
        provisioner,
        makeRefs(),
        d,
      );
      // Bind the probe (default: no open sessions = reapable).
      m.bindOpenSessionsProbe(opts.openSessions ?? (async () => 0));
      return { m, d };
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-19T00:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reaps a clean + idle + session-less branch workstation', async () => {
      const { m } = reaperManager({});
      const rec = await m.ensureWorkspace(TEAM, PROJECT, BRANCH, BASE_REF, UPSTREAM);
      // Advance past the TTL so it's idle.
      vi.setSystemTime(new Date(Date.now() + PAST_TTL_MS));

      await m.reapIdleWorkstations();

      expect(engine.removed).toContain(rec.containerId);
      expect(engine.removedVolumes).toContain(`agent-ws-docker-${rec.workspaceId}`);
      expect(registry.get(rec.workspaceId)).toBeUndefined();
    });

    it('SKIPS a workstation with unpushed commits (aheadOfOrigin > 0)', async () => {
      const { m } = reaperManager({ syncStatus: { aheadOfOrigin: 3, dirty: false } });
      const rec = await m.ensureWorkspace(TEAM, PROJECT, BRANCH, BASE_REF, UPSTREAM);
      vi.setSystemTime(new Date(Date.now() + PAST_TTL_MS));

      await m.reapIdleWorkstations();

      expect(engine.removed).not.toContain(rec.containerId);
      expect(registry.get(rec.workspaceId)).toBeDefined();
    });

    it('SKIPS a DIRTY workstation (uncommitted changes)', async () => {
      const { m } = reaperManager({ syncStatus: { aheadOfOrigin: 0, dirty: true } });
      const rec = await m.ensureWorkspace(TEAM, PROJECT, BRANCH, BASE_REF, UPSTREAM);
      vi.setSystemTime(new Date(Date.now() + PAST_TTL_MS));

      await m.reapIdleWorkstations();

      expect(engine.removed).not.toContain(rec.containerId);
      expect(registry.get(rec.workspaceId)).toBeDefined();
    });

    it('SKIPS a workstation with an OPEN session (even when clean + idle)', async () => {
      const { m } = reaperManager({ openSessions: async () => 1 });
      const rec = await m.ensureWorkspace(TEAM, PROJECT, BRANCH, BASE_REF, UPSTREAM);
      vi.setSystemTime(new Date(Date.now() + PAST_TTL_MS));

      await m.reapIdleWorkstations();

      expect(engine.removed).not.toContain(rec.containerId);
      expect(registry.get(rec.workspaceId)).toBeDefined();
    });

    it('SKIPS a workstation still WITHIN the TTL (recently active)', async () => {
      const { m } = reaperManager({});
      const rec = await m.ensureWorkspace(TEAM, PROJECT, BRANCH, BASE_REF, UPSTREAM);
      // Only half the TTL elapses — not idle yet.
      vi.setSystemTime(new Date(Date.now() + (TTL_MIN / 2) * 60 * 1000));

      await m.reapIdleWorkstations();

      expect(engine.removed).not.toContain(rec.containerId);
      expect(registry.get(rec.workspaceId)).toBeDefined();
    });

    it('SKIPS when the daemon is UNREACHABLE for the reap-safety check (never reap on doubt)', async () => {
      const { m } = reaperManager({ syncThrows: true });
      const rec = await m.ensureWorkspace(TEAM, PROJECT, BRANCH, BASE_REF, UPSTREAM);
      vi.setSystemTime(new Date(Date.now() + PAST_TTL_MS));

      await m.reapIdleWorkstations();

      expect(engine.removed).not.toContain(rec.containerId);
      expect(registry.get(rec.workspaceId)).toBeDefined();
    });

    it('touch() resets the idle clock so a re-active workstation is not reaped', async () => {
      const { m } = reaperManager({});
      const rec = await m.ensureWorkspace(TEAM, PROJECT, BRANCH, BASE_REF, UPSTREAM);
      // Advance to just-past TTL, but a session event lands (touch) right before the sweep.
      vi.setSystemTime(new Date(Date.now() + PAST_TTL_MS));
      m.touch(rec.workspaceId);

      await m.reapIdleWorkstations();

      expect(engine.removed).not.toContain(rec.containerId);
    });

    it('leaves a legacy NO-BRANCH sandbox alone (workstation model is per-branch)', async () => {
      const { m } = reaperManager({});
      // Seed a managed container WITHOUT a branch label (predates per-branch identity), then reconcile.
      engine.seed(
        {
          name: 'agent-ws-legacy',
          image: 'img',
          env: [],
          labels: {
            'com.agent.managed': '1',
            'com.agent.workspace': 'legacy-1',
            'com.agent.team': TEAM,
            'com.agent.project': PROJECT,
          },
          privileged: true,
          binds: [],
          restartPolicy: 'unless-stopped',
        },
        'running',
      );
      await m.reconcile();
      vi.setSystemTime(new Date(Date.now() + PAST_TTL_MS));

      await m.reapIdleWorkstations();

      expect(registry.get('legacy-1')).toBeDefined();
    });
  });

  // ── Phase 2: dev-server port ALLOCATOR (one localhost-only published port per workstation) ─────────

  describe('dev-port allocator', () => {
    it('allocates the lowest free host port, AVOIDING ports already taken by a managed container', async () => {
      // Seed a managed sandbox that already holds the bottom of the pool (39000) on its devport label.
      engine.seed(
        {
          name: 'agent-ws-taken',
          image: 'img',
          env: [],
          labels: {
            'com.agent.managed': '1',
            'com.agent.workspace': 'taken-1',
            'com.agent.team': 'team-other',
            'com.agent.project': 'proj-other',
            'com.agent.branch': 'feature/z',
            'com.agent.devport': '39000',
          },
          privileged: true,
          binds: [],
          restartPolicy: 'unless-stopped',
        },
        'running',
      );

      const rec = await ensure(manager);
      // 39000 is taken → the allocator picks the next free port (39001), localhost-bound.
      expect(rec.devPort).toBe(39001);
      expect(engine.created[0].ports).toEqual([
        { hostIp: '127.0.0.1', hostPort: 39001, containerPort: 7000 },
      ]);
      expect(engine.created[0].labels['com.agent.devport']).toBe('39001');
    });

    it('TWO workstations never double-bind — the second avoids the first', async () => {
      const a = await ensure(manager, TEAM, PROJECT, 'feature/a');
      const b = await ensure(manager, TEAM, PROJECT, 'feature/b');
      expect(a.devPort).toBe(39000);
      expect(b.devPort).toBe(39001);
      expect(a.devPort).not.toBe(b.devPort);
    });

    it('WORKSPACE_DEV_PORT + WORKSPACE_PORT_RANGE_START override the container port + pool start', async () => {
      const m = new ContainerManagerService(
        engine,
        makeEnv({
          WORKSPACE_DEV_PORT: '5173',
          WORKSPACE_PORT_RANGE_START: '40000',
          WORKSPACE_PORT_RANGE_END: '40010',
        }),
        makeProjects(),
        registry,
        credentials,
        readiness,
        provisioner,
        makeRefs(),
        daemon,
      );
      const rec = await m.ensureWorkspace(TEAM, PROJECT, BRANCH, BASE_REF, UPSTREAM);
      expect(rec.devPort).toBe(40000);
      expect(engine.created[0].ports).toEqual([
        { hostIp: '127.0.0.1', hostPort: 40000, containerPort: 5173 },
      ]);
    });

    it('GRACEFULLY falls back to NO published port when the pool is exhausted (create still succeeds)', async () => {
      // A 1-wide pool [40000..40000]: the first create takes it, the second finds the pool exhausted.
      const m = new ContainerManagerService(
        engine,
        makeEnv({
          WORKSPACE_PORT_RANGE_START: '40000',
          WORKSPACE_PORT_RANGE_END: '40000',
        }),
        makeProjects(),
        registry,
        credentials,
        readiness,
        provisioner,
        makeRefs(),
        daemon,
      );
      const first = await m.ensureWorkspace(TEAM, PROJECT, 'feature/a', BASE_REF, UPSTREAM);
      expect(first.devPort).toBe(40000);

      const second = await m.ensureWorkspace(TEAM, PROJECT, 'feature/b', BASE_REF, UPSTREAM);
      // Pool exhausted → the workstation is created WITHOUT a published port, but creation SUCCEEDS.
      expect(second.workspaceId).toBeDefined();
      expect(second.status).toBe('running');
      expect(second.devPort).toBeUndefined();
      const secondSpec = engine.created[1];
      expect(secondSpec.ports).toBeUndefined();
      expect(secondSpec.labels['com.agent.devport']).toBeUndefined();
    });

    it('RECONCILES the dev port from the label on boot adoption (survives a restart)', async () => {
      engine.seed(
        {
          name: 'agent-ws-reconcile',
          image: 'img',
          env: [],
          labels: {
            'com.agent.managed': '1',
            'com.agent.workspace': 'rec-1',
            'com.agent.team': TEAM,
            'com.agent.project': PROJECT,
            'com.agent.branch': BRANCH,
            'com.agent.devport': '39007',
          },
          privileged: true,
          binds: [],
          restartPolicy: 'unless-stopped',
        },
        'running',
      );
      await manager.onApplicationBootstrap();
      expect(registry.get('rec-1')?.devPort).toBe(39007);
    });
  });

  describe('boot-time daemon-version reconciliation', () => {
    const CURRENT = 'sha-current';

    /** Seed a running managed sandbox on (team, project, branch) so reconcile adopts it into the registry. */
    function seedRunning(wsId: string, branch = BRANCH): void {
      engine.seed(
        {
          name: `agent-ws-${wsId}`,
          image: 'img',
          env: [],
          labels: {
            'com.agent.managed': '1',
            'com.agent.workspace': wsId,
            'com.agent.team': TEAM,
            'com.agent.project': PROJECT,
            'com.agent.branch': branch,
          },
          privileged: true,
          binds: [],
          restartPolicy: 'unless-stopped',
        },
        'running',
      );
    }

    /** Build a manager whose provisioner reports `current` as the just-built version and whose daemon's
     * `version()` RPC is driven by `versionByWs` (a throw if the id maps to an Error, else `{buildVersion}`). */
    function buildManager(
      current: string | undefined,
      versionByWs: Record<string, string | Error>,
    ): ContainerManagerService {
      const gitCall = vi.fn(async (id: string, method: string) => {
        if (method !== 'version') return undefined;
        const v = versionByWs[id];
        if (v instanceof Error) throw v;
        return { buildVersion: v };
      });
      const daemonFake = { gitCall } as unknown as DaemonClient & {
        gitCall: ReturnType<typeof vi.fn>;
      };
      return new ContainerManagerService(
        engine,
        makeEnv(),
        makeProjects(),
        registry,
        credentials,
        makeReadiness(),
        makeProvisioner(current),
        makeRefs(),
        daemonFake,
      );
    }

    it('restarts a sandbox whose reported version ≠ current, and never recreates it', async () => {
      seedRunning('stale-1');
      const m = buildManager(CURRENT, { 'stale-1': 'sha-OLD' });

      await m.onApplicationBootstrap();

      // Restarted onto the new daemon — via restart, NOT remove/recreate (the clone must survive).
      expect(engine.restarted).toContain(
        registry.get('stale-1')?.containerId ?? 'MISSING',
      );
      expect(engine.removed).toHaveLength(0);
      m.onModuleDestroy();
    });

    it('restarts a sandbox whose version() RPC THROWS (an old daemon with no such RPC)', async () => {
      seedRunning('old-1');
      const m = buildManager(CURRENT, {
        'old-1': new Error('unknown git RPC method version'),
      });

      await m.onApplicationBootstrap();

      expect(engine.restarted).toContain(registry.get('old-1')?.containerId);
      expect(engine.removed).toHaveLength(0);
      m.onModuleDestroy();
    });

    it('SKIPS a sandbox already on the current version (idempotent no-op)', async () => {
      seedRunning('current-1');
      const m = buildManager(CURRENT, { 'current-1': CURRENT });

      await m.onApplicationBootstrap();

      expect(engine.restarted).toHaveLength(0);
      m.onModuleDestroy();
    });

    it('a restart FAILURE is logged and the sweep continues to the next sandbox', async () => {
      seedRunning('stale-a', 'feature/a');
      seedRunning('stale-b', 'feature/b');
      const m = buildManager(CURRENT, {
        'stale-a': 'sha-OLD',
        'stale-b': 'sha-OLD',
      });
      // The FIRST restart rejects — the sweep must still attempt (and succeed) the second.
      engine.failNextRestart = true;

      await m.onApplicationBootstrap();

      // Exactly one container restarted successfully; the failed one was swallowed (no throw, no recreate).
      expect(engine.restarted).toHaveLength(1);
      expect(engine.removed).toHaveLength(0);
      m.onModuleDestroy();
    });

    it('SKIPS the whole sweep when no current build version is known (build predates the stamp)', async () => {
      seedRunning('whatever-1');
      const m = buildManager(undefined, { 'whatever-1': 'sha-OLD' });

      await m.onApplicationBootstrap();

      // No target version → never bounce a running sandbox blindly.
      expect(engine.restarted).toHaveLength(0);
      m.onModuleDestroy();
    });
  });
});
