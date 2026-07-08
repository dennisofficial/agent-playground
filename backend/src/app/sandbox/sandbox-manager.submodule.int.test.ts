import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EnvService } from '@core/config/env/env.service';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalGitService, type FeatureSandbox, type ProjectRepo } from '../git';
import { bundleEngine, bundleMcpBridge, bundleMcpHub } from './bundle-engine';
import { CONTAINER_GIT_COMMON, CONTAINER_WORKTREE } from './container-paths';
import { DockerodeContainerEngine } from './dockerode-container-engine';
import { SandboxImageBuilder } from './sandbox-image.builder';
import { SandboxManager } from './sandbox-manager.service';

/**
 * End-to-end proof of the submodule ship-step fix (decision d1) at the layer the bug actually manifests:
 * a real Docker sandbox container attached to a FULL-CLONE-provisioned submodule repo can run `git add -A`
 * inside `/workspace` and it SUCCEEDS — the exact operation that fataled in prod with `cannot chdir` /
 * `not a git repository`.
 *
 * A submodule repo is now provisioned as a full local clone (real `.git` DIR under `/workspace`, submodule
 * gitdirs under `/workspace/.git/modules/…`), so the attach guard (`sandbox-manager.service.ts:284`) skips
 * the linked-worktree overlay entirely: there is NO `/.atlas/git-common` bind and NO `/workspace/.git`
 * shadow. Everything lives on the single `/workspace` mount, so the submodule's relative `core.worktree`
 * resolves in-container. This test is the executable proof of that "no attach change needed" claim.
 *
 * Local submodule remotes use `file://`, which git blocks by default. Production deliberately leaves that
 * transport disabled (tenant-repo safety); the test opts in via the `GIT_ALLOW_PROTOCOL` env hatch — the
 * prod code never sets it. Needs Docker; a no-op when Docker is unreachable.
 */
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
    // Opt into file:// submodule transport for THIS process (prod never does).
    prevAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = 'file:https:ssh';

    // Keep everything under the repos tmp so it's a Docker-shared path on macOS.
    root = mkdtempSync(join(tmpdir(), 'atlas-sbxmgr-submod-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'atlas-sbxhome-submod-'));
    const gitSvc = new LocalGitService(env());

    // 1. A submodule "remote" (one committed file).
    const subRemote = join(root, 'sub-remote');
    await execFileAsync('mkdir', ['-p', subRemote]);
    await g(['init', '-q', '-b', 'main'], subRemote);
    await g(['config', 'user.email', 'test@atlas.dev'], subRemote);
    await g(['config', 'user.name', 'Test'], subRemote);
    writeFileSync(join(subRemote, 'package.json'), '{"name":"@workspace/shared"}');
    await g(['add', '-A'], subRemote);
    await g(['commit', '-qm', 'sub'], subRemote);

    // 2. A superproject "remote" that adds the submodule at packages/shared (relative url).
    const superRemote = join(root, 'super-remote');
    await execFileAsync('mkdir', ['-p', superRemote]);
    await g(['init', '-q', '-b', 'main'], superRemote);
    await g(['config', 'user.email', 'test@atlas.dev'], superRemote);
    await g(['config', 'user.name', 'Test'], superRemote);
    writeFileSync(join(superRemote, 'README.md'), '# super');
    await g(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../sub-remote', 'packages/shared'], superRemote);
    await g(['add', '-A'], superRemote);
    await g(['commit', '-qm', 'super'], superRemote);

    // 3. The persistent MAIN CLONE — `createBaseWorktree` clones FROM this, and `repoHasSubmodules`
    // reads its checked-out `.gitmodules`.
    const gitUrl = `file://${superRemote}`;
    const mainClone = join(root, 'mainclone');
    await g(['clone', '-q', gitUrl, mainClone], root);
    repo = { repoId: 'proj-submod', gitUrl, defaultBranch: 'main', repoPath: mainClone };

    // 4. Provision the worktree exactly as the live path does: full clone → feature branch → submodules.
    const base = await gitSvc.createBaseWorktree(repo, 'submod-1');
    worktree = base.worktreePath;
    const branched = await gitSvc.switchBranch(base, repo, 'atlas/submod-fix');
    await gitSvc.ensureSubmodules(worktree, repo);

    sandbox = { repoId: repo.repoId, branch: branched.branch, worktreePath: worktree, gitUrl: '' };
    manager = new SandboxManager(engine, builder, env({ AGENT_HOME_ROOT: homeRoot }));

    if (!dockerUp) return;
    // Reclaim any STALE container from a prior run (deterministic name → warm reuse with dead binds).
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
    // Host-side fast fail — proves the clone path took effect before we ever touch Docker.
    expect(statSync(join(worktree, '.git')).isDirectory()).toBe(true);
    expect(existsSync(join(worktree, '.git', 'modules', 'packages', 'shared'))).toBe(true);
  });

  it('attaches with NO linked-worktree overlay and runs `git add -A` in-container without fataling', async () => {
    if (!dockerUp) {
      // eslint-disable-next-line no-console
      console.warn('Docker not reachable — skipping SandboxManager submodule integration test');
      return;
    }
    // The engine + MCP bundles are generated, not committed — produce them (as the API does on boot)
    // before building the image, which COPYs them into the build context.
    await bundleEngine();
    await bundleMcpBridge();
    await bundleMcpHub();
    await builder.ensureImage();

    const attached = await manager.attach({ sandbox, orgId: 'team-submod' });
    containerId = attached.containerId;
    expect(attached.containerId).toBeTruthy();
    expect(attached.execUser).toMatch(/^\d+:\d+$/);
    const containerName = (await engine.inspect(attached.containerId!))!.name;
    artifacts = { net: `${containerName}-net`, vol: `${containerName}-dind` };

    // Positive proof the CLONE path took effect: the worktree is bound at /workspace, but the guard skipped
    // the linked-worktree overlay — NO /.atlas/git-common bind and NO /workspace/.git shadow (the clone's
    // `.git` is a real dir on the single /workspace mount, so it needs neither).
    const raw = await new Docker().getContainer(attached.containerId!).inspect();
    const mounts = (raw.Mounts ?? []) as Array<{ Destination?: string }>;
    expect(mounts.some((m) => m.Destination === CONTAINER_WORKTREE)).toBe(true);
    expect(mounts.some((m) => m.Destination === CONTAINER_GIT_COMMON)).toBe(false);
    expect(mounts.some((m) => m.Destination === `${CONTAINER_WORKTREE}/.git`)).toBe(false);

    // THE PROD REPRO, now green: touch a file, stage EVERYTHING (which recurses into the submodule), and
    // read status back. This fataled in prod with exit 128 (`cannot chdir` / `not a git repository`).
    const r = await engine.exec(
      attached.containerId!,
      ['bash', '-c', `cd ${CONTAINER_WORKTREE} && touch newfile.txt && git -c core.hooksPath=/dev/null add -A && git status --porcelain`],
      { user: attached.execUser },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('newfile.txt');

    // The submodule checkout resolves in-container (no `not a git repository`) — its relative core.worktree
    // bridges within the single /workspace mount.
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
