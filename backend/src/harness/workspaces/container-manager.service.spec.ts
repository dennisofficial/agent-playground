/**
 * Phase 6 host sandbox-lifecycle unit tests — `ContainerManagerService` against the in-memory container
 * engine fake (NO Docker socket). Covers:
 *   (a) `ensureWorkspace` create-then-find idempotency + the exact create spec (managed labels,
 *       privileged, NO host ports, env carrying REDIS_URL/WORKSPACE_ID/DAEMON_BOOTSTRAP_TOKEN, limits);
 *   (b) boot reconciliation rebuilds the registry from labelled containers.
 * `ProjectStore`/`EnvService`/`CredentialProvisionerService` are mocked.
 */
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { ProjectStore } from '../projects/project-store';
import { ContainerManagerService } from './container-manager.service';
import type { CredentialProvisionerService } from './credential-provisioner.service';
import { InMemoryContainerEngine } from './in-memory-container-engine';
import type { SandboxReadinessService } from './sandbox-readiness.service';
import { SandboxRegistry } from './sandbox-registry';

const TEAM = 'team-1';
const PROJECT = 'proj-1';
const REPO = 'https://github.com/acme/proj-1';

function makeEnv(over: Record<string, string> = {}): EnvService {
  const values: Record<string, string | undefined> = {
    WORKSPACE_IMAGE: 'agent-sandbox:pinned',
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

describe('ContainerManagerService (in-memory container engine)', () => {
  let engine: InMemoryContainerEngine;
  let registry: SandboxRegistry;
  let credentials: CredentialProvisionerService;
  let readiness: SandboxReadinessService;
  let manager: ContainerManagerService;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    engine = new InMemoryContainerEngine();
    registry = new SandboxRegistry();
    credentials = makeCredentials();
    readiness = makeReadiness();
    manager = new ContainerManagerService(
      engine,
      makeEnv(),
      makeProjects(),
      registry,
      credentials,
      readiness,
    );
  });

  it('(a) ensureWorkspace creates a sandbox with the correct spec', async () => {
    const rec = await manager.ensureWorkspace(TEAM, PROJECT);

    expect(engine.created).toHaveLength(1);
    const spec = engine.created[0];

    // uuid name, sanitized
    expect(spec.name).toMatch(/^agent-ws-[0-9a-f-]{36}$/);
    expect(spec.image).toBe('agent-sandbox:pinned');

    // privileged DinD, restart policy, runtime default
    expect(spec.privileged).toBe(true);
    expect(spec.restartPolicy).toBe('unless-stopped');
    expect(spec.runtime).toBe('runc');

    // managed labels
    expect(spec.labels).toMatchObject({
      'com.agent.managed': '1',
      'com.agent.workspace': rec.workspaceId,
      'com.agent.team': TEAM,
      'com.agent.project': PROJECT,
      'com.agent.repo': REPO,
    });

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
    expect(spec.network).toBe('agent-playground_default');
    // Storage driver NOT injected when WORKSPACE_DOCKER_STORAGE_DRIVER is unset (entrypoint auto-detects).
    expect(spec.env.some((e) => e.startsWith('DOCKERD_STORAGE_DRIVER='))).toBe(
      false,
    );

    // per-sandbox docker-storage volume mount for the inner DinD
    expect(spec.binds).toContain(
      `agent-ws-docker-${rec.workspaceId}:/var/lib/docker`,
    );

    // resource limits set
    expect(spec.memoryBytes).toBeGreaterThan(0);
    expect(spec.nanoCpus).toBeGreaterThan(0);
    expect(spec.pidsLimit).toBeGreaterThan(0);

    // NO host port bindings / NO published ports — the spec has no port fields at all.
    expect(spec).not.toHaveProperty('ports');
    expect(spec).not.toHaveProperty('portBindings');

    // started + registered + cred channel watched
    expect(rec.status).toBe('running');
    expect(registry.get(rec.workspaceId)).toEqual(rec);
    expect(credentials.watch).toHaveBeenCalledWith(rec.workspaceId);
  });

  it('(a) ensureWorkspace is idempotent — a second call finds, never re-creates', async () => {
    const first = await manager.ensureWorkspace(TEAM, PROJECT);
    const second = await manager.ensureWorkspace(TEAM, PROJECT);

    expect(engine.created).toHaveLength(1); // only ONE container ever created
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.containerId).toBe(first.containerId);
    // The found path preserves the in-process bootstrap token.
    expect(second.bootstrapToken).toBe(first.bootstrapToken);
  });

  it('(a) resolveForSession lazily ensures via the bound ensurer', async () => {
    const rec = await registry.resolveForSession({
      team: TEAM,
      project: PROJECT,
    });
    expect(engine.created).toHaveLength(1);
    expect(rec.team).toBe(TEAM);
    // A second resolve reuses the same sandbox (no new container).
    const again = await registry.resolveForSession({
      team: TEAM,
      project: PROJECT,
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
    );
    await expect(manager.ensureWorkspace(TEAM, PROJECT)).rejects.toThrow(
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
    );
    await manager.ensureWorkspace(TEAM, PROJECT);
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
    );
    await manager.ensureWorkspace(TEAM, PROJECT);
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

    // find() resolves the existing sandbox without a new container.
    const found = registry.find({ team: TEAM, project: PROJECT });
    expect(found?.workspaceId).toBe(wsIdA);
  });

  it('(e) create persists the bootstrap token as the com.agent.boot-token label', async () => {
    const rec = await manager.ensureWorkspace(TEAM, PROJECT);
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
    const found = await manager.ensureWorkspace(TEAM, PROJECT);
    expect(found.workspaceId).toBe(wsId);
    expect(found.bootstrapToken).toBe('persisted-token-123');
  });

  it('destroyWorkspace stops + removes the container, unwatches creds, and clears readiness', async () => {
    const rec = await manager.ensureWorkspace(TEAM, PROJECT);
    await manager.destroyWorkspace(rec.workspaceId);

    expect(engine.removed).toContain(rec.containerId);
    expect(registry.get(rec.workspaceId)).toBeUndefined();
    expect(credentials.unwatch).toHaveBeenCalledWith(rec.workspaceId);
    expect(readiness.forget).toHaveBeenCalledWith(rec.workspaceId);
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
    );
    await expect(manager.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });
});
