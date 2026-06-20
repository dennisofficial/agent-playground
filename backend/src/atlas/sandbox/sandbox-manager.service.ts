import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FeatureSandbox } from '../git';
import { CONTAINER_AGENT_HOME } from './docker-engine-runner';
import { CONTAINER_ENGINE, type ContainerEngine } from './container-engine.port';
import { SandboxImageBuilder } from './sandbox-image.builder';
import type { SandboxAttachInput, SandboxProvider } from './sandbox-provider.port';

const execFileAsync = promisify(execFile);

/** Labels — the source of truth for boot adoption + reaping. */
const L_MANAGED = 'atlas.managed';
const L_TEAM = 'atlas.team';
const L_PROJECT = 'atlas.project';
const L_BRANCH = 'atlas.branch';

/**
 * The `docker` SANDBOX_PROVIDER binding — owns the lifecycle of per-feature sandbox containers. One
 * long-lived, privileged, network-isolated container per `team · project · branch` (the same unit as
 * the worktree). `attach` is idempotent: it reuses a running container, restarts a stopped one, or
 * creates+starts a fresh one — bind-mounting the worktree (and its git common dir) at their SAME host
 * paths so in-container git resolves, plus a host-owned agent-home at {@link CONTAINER_AGENT_HOME} so
 * engine sessions persist across turns/restarts. Turns are then `docker exec`'d in by the
 * `DockerEngineRunner`. Containers are kept alive after a build (so a dev server stays reachable);
 * `teardown` / `reapStopped` reclaim them. Labels are the source of truth for adoption (no new table).
 *
 * Inner dockerd (DinD) comes from `--privileged` + a per-sandbox /var/lib/docker volume (proven in D0);
 * `attach` waits for it to report ready before returning so the first build turn can use it.
 */
@Injectable()
export class SandboxManager implements SandboxProvider {
  private readonly logger = new Logger(SandboxManager.name);

  constructor(
    @Inject(CONTAINER_ENGINE) private readonly engine: ContainerEngine,
    private readonly images: SandboxImageBuilder,
    private readonly env: EnvService,
  ) {}

  async attach(input: SandboxAttachInput): Promise<FeatureSandbox> {
    const { sandbox, teamId } = input;
    const name = this.containerName(teamId, sandbox.projectId, sandbox.branch);

    const existing = await this.engine.inspect(name);
    if (existing) {
      if (existing.state !== 'running') {
        this.logger.log(`reusing stopped sandbox ${name} — starting`);
        await this.engine.start(existing.id);
        await this.waitReady(existing.id);
      } else {
        this.logger.log(`reusing running sandbox ${name}`);
      }
      return this.augment(sandbox, existing.id);
    }

    await this.softCapCheck();

    const image = await this.images.ensureImage();
    const network = `${name}-net`;
    await this.engine.ensureNetwork(network);

    const hostHome = join(this.agentHomeRootHost(), 'sandboxes', name);
    mkdirSync(hostHome, { recursive: true });

    const binds = [`${sandbox.worktreePath}:${sandbox.worktreePath}`, `${hostHome}:${CONTAINER_AGENT_HOME}`];
    const gitDir = await this.gitCommonDir(sandbox.worktreePath);
    if (gitDir && !gitDir.startsWith(`${sandbox.worktreePath}/`)) {
      // Linked worktree: its .git lives outside cwd — mount it at the same path so git resolves.
      binds.push(`${gitDir}:${gitDir}`);
    }
    // The host-maintained, READ-ONLY cross-repo reference library (per-tenant) at /refs.
    const refsDir = this.teamRefsDir(teamId);
    if (refsDir) {
      mkdirSync(refsDir, { recursive: true });
      binds.push(`${refsDir}:/refs:ro`);
    }

    this.logger.log(`creating sandbox ${name} (image ${image}, net ${network})`);
    const id = await this.engine.createContainer({
      name,
      image,
      network,
      privileged: true,
      binds,
      volumes: [{ name: `${name}-dind`, path: '/var/lib/docker' }],
      labels: {
        [L_MANAGED]: '1',
        [L_TEAM]: teamId,
        [L_PROJECT]: sandbox.projectId,
        [L_BRANCH]: sandbox.branch,
      },
    });
    await this.engine.start(id);
    await this.waitReady(id);
    return this.augment(sandbox, id);
  }

  async teardown(sandbox: FeatureSandbox): Promise<void> {
    if (!sandbox.containerId) return;
    const info = await this.engine.inspect(sandbox.containerId);
    await this.engine.remove(sandbox.containerId, { force: true });
    if (info) {
      // Best-effort: drop the per-sandbox network (it shares the container name stem).
      this.logger.log(`tore down sandbox ${info.name}`);
    }
  }

  /** Remove STOPPED managed containers (safe reclaim — never touches a running sandbox a dev server
   * might be using). TTL-based reaping of running-but-idle sandboxes needs job-state awareness and is
   * deferred. */
  async reapStopped(): Promise<number> {
    const managed = await this.engine.list({ label: `${L_MANAGED}=1`, all: true });
    let reaped = 0;
    for (const c of managed) {
      if (c.state !== 'running') {
        await this.engine.remove(c.id, { force: true }).catch(() => undefined);
        reaped++;
      }
    }
    if (reaped) this.logger.log(`reaped ${reaped} stopped sandbox(es)`);
    return reaped;
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────

  private augment(sandbox: FeatureSandbox, containerId: string): FeatureSandbox {
    const user = this.hostUser();
    return { ...sandbox, containerId, ...(user ? { execUser: user } : {}) };
  }

  /** Run engine turns as the host uid so worktree files written in-container stay host-owned. */
  private hostUser(): string | undefined {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
    return uid !== undefined && gid !== undefined ? `${uid}:${gid}` : undefined;
  }

  private agentHomeRootHost(): string {
    return (
      this.env.get('ATLAS_AGENT_HOME_ROOT') ??
      this.env.get('AGENT_HOME_ROOT') ??
      join(homedir(), '.agent-playground', 'atlas-agent-home')
    );
  }

  /** The per-tenant reference-library dir mounted read-only at /refs (undefined → no /refs). */
  private teamRefsDir(teamId: string): string | undefined {
    const root = this.env.get('ATLAS_REFS_ROOT') ?? this.env.get('REFS_ROOT');
    if (!root) return undefined;
    return join(root, teamId.replace(/[^a-z0-9_-]/gi, '_') || 'team');
  }

  /** Poll the inner dockerd until it reports ready (or give up after the window, non-fatal). */
  private async waitReady(containerId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.engine
        .exec(containerId, ['docker', 'info', '--format', '{{.ServerVersion}}'])
        .catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
      if (r.exitCode === 0 && r.stdout.trim()) return;
      await new Promise((res) => setTimeout(res, 1000));
    }
    this.logger.warn(`sandbox ${containerId.slice(0, 12)} inner dockerd not ready in ${timeoutMs}ms — continuing`);
  }

  /** Absolute git common dir for a worktree (so a linked worktree's external .git can be mounted). */
  private async gitCommonDir(worktreePath: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: worktreePath },
      );
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Soft cap: warn (and reclaim stopped) if too many sandboxes are live — never blocks the drive. */
  private async softCapCheck(): Promise<void> {
    const cap = this.env.get('ATLAS_MAX_CONCURRENT_SANDBOXES');
    if (!cap) return;
    const running = (await this.engine.list({ label: `${L_MANAGED}=1`, all: false })).length;
    if (running >= cap) {
      this.logger.warn(`live sandboxes (${running}) at/over ATLAS_MAX_CONCURRENT_SANDBOXES (${cap}) — reaping stopped`);
      await this.reapStopped();
    }
  }

  private containerName(teamId: string, projectId: string, branch: string): string {
    const part = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40);
    return `atlas-sbx-${part(teamId)}-${part(projectId)}-${part(branch)}`.slice(0, 120);
  }
}
