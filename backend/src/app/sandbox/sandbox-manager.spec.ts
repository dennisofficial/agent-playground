import type { EnvService } from '@core/config/env/env.service';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTAINER_GIT_COMMON } from './container-paths';
import type {
  ContainerEngine,
  ContainerInfo,
  NetworkInfo,
  VolumeInfo,
} from './container-engine.port';
import type { FeatureSandbox } from '../git';
import type { SandboxAttachInput } from './sandbox-provider.port';
import { SandboxImageBuilder } from './sandbox-image.builder';
import {
  SandboxManager,
  dedupeBindsByTarget,
  rebaseDotGit,
  submoduleGitlinks,
} from './sandbox-manager.service';

const env = (v: Record<string, string | undefined> = {}) =>
  ({ get: (k: string) => v[k] }) as unknown as EnvService;

/**
 * A fake ContainerEngine whose `list`/`listNetworks`/`listVolumes` return scripted state and whose
 * `removeNetwork`/`removeVolume` record (or reject) so we can assert the orphan-reaper's name-matching.
 */
function fakeEngine(state: {
  containers: string[];
  networks: string[];
  volumes: string[];
  failRemove?: Set<string>;
}) {
  const removedNetworks: string[] = [];
  const removedVolumes: string[] = [];
  const engine: ContainerEngine = {
    ensureNetwork: vi.fn(),
    connectNetwork: vi.fn(),
    disconnectNetwork: vi.fn(),
    execDetached: vi.fn(),
    imageExists: vi.fn(),
    imageId: vi.fn(),
    imageLabels: vi.fn(),
    buildImage: vi.fn(),
    createContainer: vi.fn(),
    start: vi.fn(),
    exec: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    removeNetwork: vi.fn(async (name: string) => {
      if (state.failRemove?.has(name))
        throw new Error(`network ${name} has active endpoints`);
      removedNetworks.push(name);
    }),
    removeVolume: vi.fn(async (name: string) => {
      if (state.failRemove?.has(name)) throw new Error(`volume ${name} in use`);
      removedVolumes.push(name);
    }),
    list: vi.fn(
      async (): Promise<ContainerInfo[]> =>
        state.containers.map((name) => ({
          id: name,
          name,
          state: 'running',
          labels: {},
          startedAt: null,
        })),
    ),
    inspect: vi.fn(),
    listNetworks: vi.fn(
      async (): Promise<NetworkInfo[]> =>
        state.networks.map((name) => ({ id: name, name })),
    ),
    listVolumes: vi.fn(
      async (): Promise<VolumeInfo[]> =>
        state.volumes.map((name) => ({ name })),
    ),
  };
  return { engine, removedNetworks, removedVolumes };
}

const manager = (engine: ContainerEngine) =>
  new SandboxManager(engine, new SandboxImageBuilder(env(), engine), env());

describe('dedupeBindsByTarget', () => {
  it('drops a colliding target keeping the LAST occurrence (system bind wins)', () => {
    // Cache mount (empty per-thread dir) pushed first, then the system shared store at the same target.
    const { binds, dropped } = dedupeBindsByTarget([
      '/caches/thread/pnpm-store:/.atlas/pnpm-store',
      '/agent-home/pnpm-store:/.atlas/pnpm-store',
    ]);
    expect(binds).toEqual(['/agent-home/pnpm-store:/.atlas/pnpm-store']);
    expect(dropped).toEqual(['/.atlas/pnpm-store']);
  });

  it('keeps nested targets (a parent and its more-specific :ro child both survive)', () => {
    const input = [
      '/host/context:/context',
      '/host/context/generated:/context/generated:ro',
      '/host/store:/.atlas/pnpm-store',
    ];
    const { binds, dropped } = dedupeBindsByTarget(input);
    expect(binds).toEqual(input);
    expect(dropped).toEqual([]);
  });
});

describe('submoduleGitlinks', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-subgit-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns [] for a repo with no .gitmodules', () => {
    expect(submoduleGitlinks(dir)).toEqual([]);
  });

  it('parses top-level submodule paths from .gitmodules', () => {
    writeFileSync(
      join(dir, '.gitmodules'),
      [
        '[submodule "packages/jwt-auth"]',
        '\tpath = packages/jwt-auth',
        '\turl = https://github.com/x/jwt-auth.git',
        '[submodule "packages/ai-testing"]',
        '  path = packages/ai-testing',
        '  url = https://github.com/x/ai-testing',
      ].join('\n'),
    );
    expect(submoduleGitlinks(dir).sort()).toEqual([
      'packages/ai-testing',
      'packages/jwt-auth',
    ]);
  });

  it('recurses into a nested submodule .gitmodules (path is relative to the superproject root)', () => {
    writeFileSync(
      join(dir, '.gitmodules'),
      '[submodule "a"]\n\tpath = a\n\turl = u',
    );
    mkdirSync(join(dir, 'a'));
    writeFileSync(
      join(dir, 'a', '.gitmodules'),
      '[submodule "b"]\n\tpath = b\n\turl = u',
    );
    expect(submoduleGitlinks(dir).sort()).toEqual(['a', 'a/b']);
  });
});

describe('rebaseDotGit', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-rebase-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rebases an ABSOLUTE submodule gitdir under the common dir onto CONTAINER_GIT_COMMON', () => {
    const common = join(dir, 'clone', '.git');
    mkdirSync(
      join(common, 'worktrees', 'wt', 'modules', 'packages', 'jwt-auth'),
      { recursive: true },
    );
    const ptrDir = join(dir, 'wt', 'packages', 'jwt-auth');
    mkdirSync(ptrDir, { recursive: true });
    const ptr = join(ptrDir, '.git');
    writeFileSync(
      ptr,
      `gitdir: ${join(common, 'worktrees', 'wt', 'modules', 'packages', 'jwt-auth')}\n`,
    );

    const out = join(dir, 'out.git');
    expect(rebaseDotGit(ptr, common, out)).toBe(out);
    expect(readFileSync(out, 'utf8')).toBe(
      `gitdir: ${CONTAINER_GIT_COMMON}/worktrees/wt/modules/packages/jwt-auth\n`,
    );
  });

  it('resolves a RELATIVE gitdir against the pointer directory before rebasing', () => {
    const common = join(dir, '.git');
    mkdirSync(join(common, 'modules', 'sub'), { recursive: true });
    const ptrDir = join(dir, 'sub');
    mkdirSync(ptrDir, { recursive: true });
    const ptr = join(ptrDir, '.git');
    writeFileSync(ptr, 'gitdir: ../.git/modules/sub\n'); // relative to ptrDir

    const out = join(dir, 'out.git');
    expect(rebaseDotGit(ptr, common, out)).toBe(out);
    expect(readFileSync(out, 'utf8')).toBe(
      `gitdir: ${CONTAINER_GIT_COMMON}/modules/sub\n`,
    );
  });

  it('bails (undefined, no file written) when the gitdir is not under the common dir', () => {
    const common = join(dir, '.git');
    mkdirSync(common, { recursive: true });
    const ptr = join(dir, '.git-pointer');
    writeFileSync(ptr, `gitdir: ${join(dir, 'elsewhere', 'modules', 'x')}\n`);
    expect(rebaseDotGit(ptr, common, join(dir, 'out.git'))).toBeUndefined();
  });

  it('returns undefined for a missing / unparseable pointer', () => {
    expect(
      rebaseDotGit(join(dir, 'nope', '.git'), dir, join(dir, 'out.git')),
    ).toBeUndefined();
    const bad = join(dir, 'bad');
    writeFileSync(bad, 'not a gitdir line\n');
    expect(rebaseDotGit(bad, dir, join(dir, 'out.git'))).toBeUndefined();
  });
});

describe('SandboxManager.reapOrphanedArtifacts', () => {
  it('removes only atlas-sbx artifacts whose owning container is gone', async () => {
    const { engine, removedNetworks, removedVolumes } = fakeEngine({
      // `...-b` is a live sandbox; `...-a` was torn down but leaked its net/vol.
      containers: ['atlas-sbx-team-proj-b', 'unrelated-container'],
      networks: [
        'atlas-sbx-team-proj-a-net',
        'atlas-sbx-team-proj-b-net',
        'bridge',
        'host',
      ],
      volumes: [
        'atlas-sbx-team-proj-a-dind',
        'atlas-sbx-team-proj-b-dind',
        'pnpm-store',
      ],
    });

    const result = await manager(engine).reapOrphanedArtifacts();

    expect(result).toEqual({ networks: 1, volumes: 1 });
    // the orphan (no `...-a` container) is reclaimed; the live one + non-atlas artifacts are untouched.
    expect(removedNetworks).toEqual(['atlas-sbx-team-proj-a-net']);
    expect(removedVolumes).toEqual(['atlas-sbx-team-proj-a-dind']);
  });

  it('reclaims nothing when every artifact still has a live container', async () => {
    const { engine, removedNetworks, removedVolumes } = fakeEngine({
      containers: ['atlas-sbx-x'],
      networks: ['atlas-sbx-x-net'],
      volumes: ['atlas-sbx-x-dind'],
    });

    expect(await manager(engine).reapOrphanedArtifacts()).toEqual({
      networks: 0,
      volumes: 0,
    });
    expect(removedNetworks).toEqual([]);
    expect(removedVolumes).toEqual([]);
  });

  it('does not count (or throw on) an artifact that fails to remove', async () => {
    const { engine } = fakeEngine({
      containers: [],
      networks: ['atlas-sbx-stuck-net'],
      volumes: ['atlas-sbx-stuck-dind'],
      failRemove: new Set(['atlas-sbx-stuck-net', 'atlas-sbx-stuck-dind']),
    });

    expect(await manager(engine).reapOrphanedArtifacts()).toEqual({
      networks: 0,
      volumes: 0,
    });
  });

  it('protects an in-flight create: a `-net`/`-dind` whose container does not exist YET is not reaped', async () => {
    // Simulates `attach` mid-create: the network/volume exist (ensureNetwork ran) but the container has not
    // been created, so there is no live container name matching the stem. The create-stamp must protect it.
    const { engine, removedNetworks, removedVolumes } = fakeEngine({
      containers: [],
      networks: ['atlas-sbx-inflight-net'],
      volumes: ['atlas-sbx-inflight-dind'],
    });
    const mgr = manager(engine);
    (mgr as unknown as { creating: Map<string, number> }).creating.set(
      'atlas-sbx-inflight',
      Date.now(),
    );

    expect(await mgr.reapOrphanedArtifacts()).toEqual({
      networks: 0,
      volumes: 0,
    });
    expect(removedNetworks).toEqual([]);
    expect(removedVolumes).toEqual([]);
  });

  it('reaps once the create-stamp ages past the grace window, and prunes the stale stamp', async () => {
    // A create that started but never produced a container (crash) leaves a stamp; after the grace window it
    // must no longer protect the leaked artifacts, and the stale map entry is pruned.
    const { engine, removedNetworks, removedVolumes } = fakeEngine({
      containers: [],
      networks: ['atlas-sbx-dead-net'],
      volumes: ['atlas-sbx-dead-dind'],
    });
    const mgr = manager(engine);
    const creating = (mgr as unknown as { creating: Map<string, number> })
      .creating;
    creating.set('atlas-sbx-dead', Date.now() - 10 * 60 * 1000); // 10m ago — well past the 5m grace

    expect(await mgr.reapOrphanedArtifacts()).toEqual({
      networks: 1,
      volumes: 1,
    });
    expect(removedNetworks).toEqual(['atlas-sbx-dead-net']);
    expect(removedVolumes).toEqual(['atlas-sbx-dead-dind']);
    expect(creating.has('atlas-sbx-dead')).toBe(false); // stale stamp pruned
  });
});

describe('SandboxManager.teardownByIdentity', () => {
  // The deterministic name `attach` derives for a thread-keyed sandbox (keyed by jobId alone — the
  // globally-unique PK): `atlas-sbx-thread-<id>`. Terminal cleanup must resolve this WITHOUT a container_id,
  // because a boot reconcile nulls the persisted id while the real container keeps running.
  const NAME = 'atlas-sbx-thread-abc';
  const sandbox = (): FeatureSandbox => ({
    repoId: 'proj',
    branch: 'feature/abc', // ignored for thread-keyed names; proves the name is keyed by jobId
    worktreePath: '/w',
    gitUrl: '',
  });

  /** A fake engine that knows ONE container by name, recording every container/net/volume removal. */
  function fake(opts: { containerExists: boolean }) {
    const removedContainers: string[] = [];
    const removedNetworks: string[] = [];
    const removedVolumes: string[] = [];
    const container: ContainerInfo = {
      id: 'cid-1',
      name: NAME,
      state: 'running',
      labels: {},
      startedAt: null,
    };
    const engine: ContainerEngine = {
      ensureNetwork: vi.fn(),
      connectNetwork: vi.fn(),
      disconnectNetwork: vi.fn(),
      execDetached: vi.fn(),
      imageExists: vi.fn(),
      imageId: vi.fn(),
      imageLabels: vi.fn(),
      buildImage: vi.fn(),
      createContainer: vi.fn(),
      start: vi.fn(),
      exec: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(async (id: string) => {
        removedContainers.push(id);
      }),
      removeNetwork: vi.fn(async (name: string) => {
        removedNetworks.push(name);
      }),
      removeVolume: vi.fn(async (name: string) => {
        removedVolumes.push(name);
      }),
      list: vi.fn(async (): Promise<ContainerInfo[]> => []),
      // Resolve ONLY by the deterministic name (a running orphan has no id we still hold).
      inspect: vi.fn(
        async (idOrName: string): Promise<ContainerInfo | null> =>
          opts.containerExists && idOrName === NAME ? container : null,
      ),
      listNetworks: vi.fn(async (): Promise<NetworkInfo[]> => []),
      listVolumes: vi.fn(async (): Promise<VolumeInfo[]> => []),
    };
    return { engine, removedContainers, removedNetworks, removedVolumes };
  }

  it('resolves a running orphan by its deterministic name and removes it + its net/vol (no container_id)', async () => {
    const { engine, removedContainers, removedNetworks, removedVolumes } = fake(
      { containerExists: true },
    );

    await manager(engine).teardownByIdentity({
      sandbox: sandbox(),
      orgId: 'team',
      jobId: 'abc',
    });

    expect(removedContainers).toEqual(['cid-1']);
    expect(removedNetworks).toEqual([`${NAME}-net`]);
    expect(removedVolumes).toEqual([`${NAME}-dind`]);
  });

  it('still reclaims leaked net/vol by name when the container is already gone', async () => {
    const { engine, removedContainers, removedNetworks, removedVolumes } = fake(
      { containerExists: false },
    );

    await manager(engine).teardownByIdentity({
      sandbox: sandbox(),
      orgId: 'team',
      jobId: 'abc',
    });

    expect(removedContainers).toEqual([]); // nothing to remove
    expect(removedNetworks).toEqual([`${NAME}-net`]);
    expect(removedVolumes).toEqual([`${NAME}-dind`]);
  });
});

describe('SandboxManager.attach — onMilestone', () => {
  // CONFIG_REV is a private module constant (currently 16); mirrored here to construct a matching
  // fingerprint label for the warm-reuse case. `atlas.cfg` mirrors the private L_CFG label key.
  const CONFIG_REV = 16;
  const IMAGE_ID = 'img-1';
  const FINGERPRINT = `${IMAGE_ID}|cfg${CONFIG_REV}|mnone|snone`; // no mounts + no setup script in these tests

  let agentHomeRoot: string;
  beforeEach(() => {
    agentHomeRoot = mkdtempSync(join(tmpdir(), 'atlas-sbxmgr-'));
  });
  afterEach(() => rmSync(agentHomeRoot, { recursive: true, force: true }));

  /** A fake engine that lets `attach()` run to completion: image ready, create succeeds, waitReady
   *  resolves on its first poll (no real 1s waits). */
  function fullFakeEngine(existing: ContainerInfo | null) {
    const createContainer = vi.fn(async () => 'new-container-id');
    const engine: ContainerEngine = {
      ensureNetwork: vi.fn(),
      connectNetwork: vi.fn(),
      disconnectNetwork: vi.fn(),
      execDetached: vi.fn(),
      imageExists: vi.fn(async () => true),
      imageId: vi.fn(async () => IMAGE_ID),
      imageLabels: vi.fn(),
      buildImage: vi.fn(),
      createContainer,
      start: vi.fn(),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: 'v1', stderr: '' })), // waitReady resolves immediately
      stop: vi.fn(),
      remove: vi.fn(),
      removeNetwork: vi.fn(),
      removeVolume: vi.fn(),
      list: vi.fn(async () => []),
      inspect: vi.fn(async () => existing),
      listNetworks: vi.fn(async () => []),
      listVolumes: vi.fn(async () => []),
    };
    return { engine, createContainer };
  }

  /** A fake `SandboxImageBuilder` whose `ensureImage` mirrors the real "fires onBuildStart only on a
   *  real rebuild" contract, controlled directly per test (bypasses real context-hashing entirely). */
  function fakeBuilder(rebuilds: boolean) {
    const ensureImage = vi.fn(async (onBuildStart?: () => void) => {
      if (rebuilds) onBuildStart?.();
      return 'atlas-sandbox:latest';
    });
    return { ensureImage } as unknown as SandboxImageBuilder;
  }

  // worktreePath is NOT a real git repo — attach()'s `gitCommonDir` shells out to `git rev-parse` and
  // safely returns undefined on failure (no linked-worktree .git bind), which is fine for these tests.
  const sandbox = (): FeatureSandbox => ({
    repoId: 'proj',
    branch: 'main',
    worktreePath: agentHomeRoot,
    gitUrl: '',
  });

  it('fires onMilestone("container_create") on a cold create (no existing container)', async () => {
    const { engine, createContainer } = fullFakeEngine(null);
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );
    const onMilestone = vi.fn();

    await mgr.attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
      onMilestone,
    } as SandboxAttachInput);

    expect(createContainer).toHaveBeenCalledOnce();
    expect(onMilestone).toHaveBeenCalledWith('container_create');
    expect(onMilestone).not.toHaveBeenCalledWith('image_build');
  });

  it('caps the sandbox: init + default CPU/memory/PID ceilings on a cold create', async () => {
    const { engine, createContainer } = fullFakeEngine(null);
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );

    await mgr.attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
    } as SandboxAttachInput);

    const spec = (
      createContainer.mock.calls[0] as unknown as [
        {
          init?: boolean;
          nanoCpus?: number;
          memoryBytes?: number;
          pidsLimit?: number;
        },
      ]
    )[0];
    expect(spec.init).toBe(true);
    expect(spec.nanoCpus).toBe(6 * 1e9);
    expect(spec.memoryBytes).toBe(24 * 1024 ** 3);
    expect(spec.pidsLimit).toBe(8192);
  });

  it('binds the durable per-job /playground scratch mount, keyed by jobId and outside the worktree', async () => {
    const { engine, createContainer } = fullFakeEngine(null);
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );

    await mgr.attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
    } as SandboxAttachInput);

    const spec = (
      createContainer.mock.calls[0] as unknown as [{ binds: string[] }]
    )[0];
    const playgroundBind = spec.binds.find((b) => b.endsWith(':/playground'));
    expect(playgroundBind).toBeDefined();
    // Host side resolves to the jobId-keyed dir (the int test proves it lives outside the worktree).
    const hostDir = playgroundBind!.slice(0, -':/playground'.length);
    expect(hostDir).toBe(mgr.playgroundDirHost('org1', 'job1'));
  });

  it('binds the durable PER-REPO /home/atlas HOME mount (host dir under the org/repo cache root, not global)', async () => {
    const { engine, createContainer } = fullFakeEngine(null);
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );

    await mgr.attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
    } as SandboxAttachInput);

    const spec = (
      createContainer.mock.calls[0] as unknown as [{ binds: string[] }]
    )[0];
    const homeBind = spec.binds.find((b) => b.endsWith(':/home/atlas'));
    expect(homeBind).toBeDefined();
    // Host side is per-repo (caches/<org>/<slug>/_home) — install-once/login-once is shared across a repo's
    // jobs, but one repo can never populate another repo's HOME/bin.
    expect(homeBind!.slice(0, -':/home/atlas'.length)).toContain(
      join('caches', 'org1', 'proj', '_home'),
    );
  });

  it('binds an EXTERNAL absolute mount at its exact path (outside /workspace) and drops a reserved one', async () => {
    const { engine, createContainer } = fullFakeEngine(null);
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );

    await mgr.attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
      mounts: [
        { path: '/root/.config/gcloud', mode: 'shared-rw' }, // external → bound at the exact path
        { path: '/etc/foo', mode: 'shared-rw' }, // reserved OS dir → dropped (defense-in-depth)
        { path: '.cache', mode: 'per-thread' }, // worktree-relative → under /workspace
      ],
    } as SandboxAttachInput);

    const spec = (
      createContainer.mock.calls[0] as unknown as [{ binds: string[] }]
    )[0];
    // External mount lands at the exact absolute container path (NOT under /workspace); host dir under _ext.
    const ext = spec.binds.find((b) => b.endsWith(':/root/.config/gcloud'));
    expect(ext).toBeDefined();
    expect(ext!.slice(0, -':/root/.config/gcloud'.length)).toContain(
      join('_shared-rw', '_ext', 'root/.config/gcloud'),
    );
    // Reserved external target is dropped — no bind for it at all.
    expect(spec.binds.some((b) => b.endsWith(':/etc/foo'))).toBe(false);
    // Worktree-relative mount still lands under /workspace.
    expect(spec.binds.some((b) => b.endsWith(':/workspace/.cache'))).toBe(true);
  });

  it('does NOT fire container_create on a warm reuse (already running, matching fingerprint)', async () => {
    const existing: ContainerInfo = {
      id: 'existing-id',
      name: 'atlas-sbx-thread-job1',
      state: 'running',
      labels: { 'atlas.cfg': FINGERPRINT },
      startedAt: null,
    };
    const { engine, createContainer } = fullFakeEngine(existing);
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );
    const onMilestone = vi.fn();

    await mgr.attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
      onMilestone,
    } as SandboxAttachInput);

    expect(createContainer).not.toHaveBeenCalled();
    expect(onMilestone).not.toHaveBeenCalled();
  });

  it('fires onMilestone("image_build") when the builder signals a real rebuild', async () => {
    const { engine } = fullFakeEngine(null);
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(true),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );
    const onMilestone = vi.fn();

    await mgr.attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
      onMilestone,
    } as SandboxAttachInput);

    expect(onMilestone).toHaveBeenCalledWith('image_build');
  });

  it('never throws when onMilestone is omitted (optional, backward-compatible)', async () => {
    const { engine } = fullFakeEngine(null);
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(true),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );

    await expect(
      mgr.attach({
        sandbox: sandbox(),
        orgId: 'org1',
        jobId: 'job1',
      } as SandboxAttachInput),
    ).resolves.toBeDefined();
  });

  // ── cold-boot setup script ──────────────────────────────────────────────────────────────────────
  const SCRIPT = 'pnpm install';
  const scriptFp = (s: string) =>
    createHash('sha256').update(s).digest('hex').slice(0, 12);

  it('runs the setup script on a COLD create (bash -c, in /workspace) and returns ok', async () => {
    const { engine } = fullFakeEngine(null);
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );

    const res = await mgr.attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
      setupScript: SCRIPT,
    } as SandboxAttachInput);

    expect(engine.exec).toHaveBeenCalledWith(
      'new-container-id',
      ['bash', '-c', SCRIPT],
      expect.objectContaining({ cwd: '/workspace' }),
    );
    expect(res.setupScriptResult).toEqual({
      ok: true,
      exitCode: 0,
      tail: expect.any(String),
    });
  });

  it('SKIPS the setup script on a warm reuse (running container, matching fingerprint incl. script hash)', async () => {
    const existing: ContainerInfo = {
      id: 'existing-id',
      name: 'atlas-sbx-thread-job1',
      state: 'running',
      labels: {
        'atlas.cfg': `${IMAGE_ID}|cfg${CONFIG_REV}|mnone|s${scriptFp(SCRIPT)}`,
      },
      startedAt: null,
    };
    const { engine } = fullFakeEngine(existing);
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );

    const res = await mgr.attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
      setupScript: SCRIPT,
    } as SandboxAttachInput);

    expect(res.setupScriptResult).toBeUndefined();
    expect(engine.exec).not.toHaveBeenCalledWith(
      'existing-id',
      ['bash', '-c', SCRIPT],
      expect.anything(),
    );
  });

  it('reports a non-zero exit as ok:false WITHOUT throwing', async () => {
    const { engine } = fullFakeEngine(null);
    // Fail only the setup-script exec; keep waitReady's `docker info` succeeding.
    engine.exec = vi.fn(async (_id: string, argv: string[]) =>
      argv[0] === 'bash'
        ? { exitCode: 2, stdout: 'boom', stderr: 'nope' }
        : { exitCode: 0, stdout: 'v1', stderr: '' },
    );
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );

    const res = await mgr.attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
      setupScript: SCRIPT,
    } as SandboxAttachInput);

    expect(res.setupScriptResult?.ok).toBe(false);
    expect(res.setupScriptResult?.exitCode).toBe(2);
  });

  it('folds the script hash into the fingerprint — different scripts → different atlas.cfg label', async () => {
    const a = fullFakeEngine(null);
    await new SandboxManager(
      a.engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    ).attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
      setupScript: 'script-A',
    } as SandboxAttachInput);
    const b = fullFakeEngine(null);
    await new SandboxManager(
      b.engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    ).attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
      setupScript: 'script-B',
    } as SandboxAttachInput);

    const cfgA = (
      a.createContainer.mock.calls[0] as unknown as [
        { labels: Record<string, string> },
      ]
    )[0].labels['atlas.cfg'];
    const cfgB = (
      b.createContainer.mock.calls[0] as unknown as [
        { labels: Record<string, string> },
      ]
    )[0].labels['atlas.cfg'];
    expect(cfgA).not.toBe(cfgB);
  });

  it('does not run or attach a result when there is no setup script', async () => {
    const { engine } = fullFakeEngine(null);
    const mgr = new SandboxManager(
      engine,
      fakeBuilder(false),
      env({ AGENT_HOME_ROOT: agentHomeRoot }),
    );

    const res = await mgr.attach({
      sandbox: sandbox(),
      orgId: 'org1',
      jobId: 'job1',
    } as SandboxAttachInput);

    expect(res.setupScriptResult).toBeUndefined();
    expect(engine.exec).not.toHaveBeenCalledWith(
      'new-container-id',
      ['bash', '-c', expect.anything()],
      expect.anything(),
    );
  });
});

describe('SandboxManager.probeLiveness', () => {
  const mkMgr = (engine: Partial<ContainerEngine>) =>
    new SandboxManager(
      engine as ContainerEngine,
      {} as SandboxImageBuilder,
      env(),
    );

  const runningContainer = (startedAt: string): ContainerInfo => ({
    id: 'c1',
    name: 'atlas-sbx-thread-job1',
    state: 'running',
    labels: {},
    startedAt,
  });

  it('reports down when no container matches the deterministic name', async () => {
    const mgr = mkMgr({ inspect: vi.fn(async () => null) });
    expect(await mgr.probeLiveness('job1', [100])).toEqual({ status: 'down' });
  });

  it('reports down when the container exists but is not running', async () => {
    const mgr = mkMgr({
      inspect: vi.fn(async () => ({
        ...runningContainer('2026-07-02T10:00:00Z'),
        state: 'exited',
      })),
    });
    expect(await mgr.probeLiveness('job1', [100])).toEqual({ status: 'down' });
  });

  it('reports up with the alive pgids parsed from the kill -0 probe stdout', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '100\n300\n',
      stderr: '',
    }));
    const mgr = mkMgr({
      inspect: vi.fn(async () => runningContainer('2026-07-02T11:00:00Z')),
      exec,
    });

    const res = await mgr.probeLiveness('job1', [100, 200, 300]);

    expect(res).toEqual({
      status: 'up',
      containerStartedAt: '2026-07-02T11:00:00Z',
      alive: [100, 300],
    });
    // Resolved the container by its deterministic name → id 'c1', and execed a kill -0 loop over the pgids.
    expect(exec).toHaveBeenCalledWith(
      'c1',
      ['sh', '-c', expect.stringContaining('kill -0')],
      expect.anything(),
    );
  });

  it('reports up with an empty alive set and does NOT exec when there are no pgids to probe', async () => {
    const exec = vi.fn();
    const mgr = mkMgr({
      inspect: vi.fn(async () => runningContainer('2026-07-02T11:00:00Z')),
      exec,
    });

    const res = await mgr.probeLiveness('job1', []);

    expect(res).toEqual({
      status: 'up',
      containerStartedAt: '2026-07-02T11:00:00Z',
      alive: [],
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports unknown (never throws) when the probe exec fails', async () => {
    const mgr = mkMgr({
      inspect: vi.fn(async () => runningContainer('2026-07-02T11:00:00Z')),
      exec: vi.fn(async () => {
        throw new Error('docker exec failed');
      }),
    });
    expect(await mgr.probeLiveness('job1', [100])).toEqual({
      status: 'unknown',
    });
  });
});
