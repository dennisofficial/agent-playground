import type { EnvService } from '@core/config/env/env.service';
import Docker from 'dockerode';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalGitService, type FeatureSandbox, type ProjectRepo } from '../../git/local-git.service';
import { bundleMcpBridge, bundleMcpHub, ensureEngineApp } from '../bundle-engine';
import { CONTAINER_GIT_COMMON, CONTAINER_WORKTREE } from '../container-paths';
import { DockerodeContainerEngine } from '../dockerode-container-engine';
import { SandboxImageBuilder } from '../sandbox-image.builder';
import { SandboxManager } from '../sandbox-manager.service';

const execFileAsync = promisify(execFile);
const env = (v: Record<string, string | undefined> = {}) =>
  ({ get: (k: string) => v[k] }) as unknown as EnvService;

let dockerUp = false;
beforeAll(async () => {
  try {
    await new Docker().ping();
    dockerUp = true;
  } catch {
    dockerUp = false;
  }
});

describe('SandboxManager — submodule repo full-clone (integration, needs Docker)', () => {
  const engine = new DockerodeContainerEngine(env());
  const builder = new SandboxImageBuilder(env(), engine);
  const g = (args: string[], cwd: string) => execFileAsync('git', args, { cwd });

  let root: string;
  let homeRoot: string;
  let worktree: string;
  let repo: ProjectRepo;
  let sandbox: FeatureSandbox;
  let manager: SandboxManager;
  let prevAllowProtocol: string | undefined;
  let containerId: string | undefined;
  let artifacts: { net: string; vol: string } | undefined;

  beforeAll(async () => {
    prevAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = 'file:https:ssh';

    root = mkdtempSync(join(tmpdir(), 'atlas-sbxmgr-submod-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'atlas-sbxhome-submod-'));
    const gitSvc = new LocalGitService(env());

    const subRemote = join(root, 'sub-remote');
    await execFileAsync('mkdir', ['-p', subRemote]);
    await g(['init', '-q', '-b', 'main'], subRemote);
    await g(['config', 'user.email', 'test@atlas.dev'], subRemote);
    await g(['config', 'user.name', 'Test'], subRemote);
    writeFileSync(join(subRemote, 'package.json'), '{"name":"@workspace/shared"}');
    await g(['add', '-A'], subRemote);
    await g(['commit', '-qm', 'sub'], subRemote);

    const superRemote = join(root, 'super-remote');
    await execFileAsync('mkdir', ['-p', superRemote]);
    await g(['init', '-q', '-b', 'main'], superRemote);
    await g(['config', 'user.email', 'test@atlas.dev'], superRemote);
    await g(['config', 'user.name', 'Test'], superRemote);
    writeFileSync(join(superRemote, 'README.md'), '# super');
    await g(
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        '../sub-remote',
        'packages/shared',
      ],
      superRemote,
    );
    await g(['add', '-A'], superRemote);
    await g(['commit', '-qm', 'super'], superRemote);

    const gitUrl = `file://${superRemote}`;
    const mainClone = join(root, 'mainclone');
    await g(['clone', '-q', gitUrl, mainClone], root);
    repo = {
      repoId: 'proj-submod',
      gitUrl,
      defaultBranch: 'main',
      repoPath: mainClone,
    };

    expect(await gitSvc.hasSubmodules(repo)).toBe(true);
    const base = await gitSvc.createBaseClone(repo, 'submod-1');
    worktree = base.worktreePath;
    const branched = await gitSvc.switchBranch(base, repo, 'atlas/submod-fix');
    await gitSvc.ensureSubmodules(worktree, repo);

    sandbox = {
      repoId: repo.repoId,
      branch: branched.branch,
      worktreePath: worktree,
      gitUrl: '',
    };
    manager = new SandboxManager(engine, builder, env({ AGENT_HOME_ROOT: homeRoot }));

    if (!dockerUp) return;
    await manager.teardownByIdentity({ sandbox, orgId: 'team-submod' });
  });

  afterAll(async () => {
    if (prevAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = prevAllowProtocol;
    if (containerId) await engine.remove(containerId, { force: true }).catch(() => undefined);
    if (artifacts) {
      await engine.removeNetwork(artifacts.net).catch(() => undefined);
      await engine.removeVolume(artifacts.vol).catch(() => undefined);
    }
    for (const p of [root, homeRoot]) if (p) rmSync(p, { recursive: true, force: true });
  });

  it('provisions the submodule repo as a full clone (real .git dir + gitdir under .git/modules)', () => {
    expect(statSync(join(worktree, '.git')).isDirectory()).toBe(true);
    expect(existsSync(join(worktree, '.git', 'modules', 'packages', 'shared'))).toBe(true);
  });

  it('attaches with NO linked-worktree overlay and runs `git add -A` in-container without fataling', async () => {
    if (!dockerUp) {
      console.warn('Docker not reachable — skipping SandboxManager submodule integration test');
      return;
    }
    ensureEngineApp();
    await bundleMcpBridge();
    await bundleMcpHub();
    await builder.ensureImage();

    const attached = await manager.attach({ sandbox, orgId: 'team-submod' });
    containerId = attached.containerId;
    expect(attached.containerId).toBeTruthy();
    expect(attached.execUser).toMatch(/^\d+:\d+$/);
    const containerName = (await engine.inspect(attached.containerId!))!.name;
    artifacts = { net: `${containerName}-net`, vol: `${containerName}-dind` };

    const raw = await new Docker().getContainer(attached.containerId!).inspect();
    const mounts = (raw.Mounts ?? []) as Array<{ Destination?: string }>;
    expect(mounts.some((m) => m.Destination === CONTAINER_WORKTREE)).toBe(true);
    expect(mounts.some((m) => m.Destination === CONTAINER_GIT_COMMON)).toBe(false);
    expect(mounts.some((m) => m.Destination === `${CONTAINER_WORKTREE}/.git`)).toBe(false);

    const r = await engine.exec(
      attached.containerId!,
      [
        'bash',
        '-c',
        `cd ${CONTAINER_WORKTREE} && touch newfile.txt && git -c core.hooksPath=/dev/null add -A && git status --porcelain`,
      ],
      { user: attached.execUser },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('newfile.txt');

    const sub = await engine.exec(
      attached.containerId!,
      ['git', '-C', `${CONTAINER_WORKTREE}/packages/shared`, 'rev-parse', '--is-inside-work-tree'],
      { user: attached.execUser },
    );
    expect(sub.exitCode).toBe(0);
    expect(sub.stdout.trim()).toBe('true');

    await manager.teardown(attached);
    expect(await engine.inspect(attached.containerId!)).toBeNull();
    containerId = undefined;
    artifacts = undefined;
  }, 600_000);
});
