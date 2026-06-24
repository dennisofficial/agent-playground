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
import { hostExecUser } from './host-exec-user';
import { SandboxImageBuilder } from './sandbox-image.builder';
import type { SandboxAttachInput, SandboxProvider } from './sandbox-provider.port';

const execFileAsync = promisify(execFile);

/** Labels — the source of truth for boot adoption + reaping. */
const L_MANAGED = 'atlas.managed';
const L_TEAM = 'atlas.team';
const L_PROJECT = 'atlas.project';
const L_BRANCH = 'atlas.branch';
const L_THREAD = 'atlas.thread';

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
    const { sandbox, orgId, threadId } = input;
    const name = this.containerName(orgId, sandbox.repoId, sandbox.branch, threadId);

    const existing = await this.engine.inspect(name);
    if (existing) {
      // Warm only when the container is already running: a stopped container we restart has lost its
      // background processes, so it is a COLD (reset) attach just like a freshly created one.
      const warm = existing.state === 'running';
      if (!warm) {
        this.logger.log(`reusing stopped sandbox ${name} — starting (cold)`);
        await this.engine.start(existing.id);
        await this.waitReady(existing.id);
      } else {
        this.logger.log(`reusing running sandbox ${name}`);
      }
      return this.augment(sandbox, existing.id, warm);
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
    const refsDir = this.teamRefsDir(orgId);
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
        [L_TEAM]: orgId,
        [L_PROJECT]: sandbox.repoId,
        [L_BRANCH]: sandbox.branch,
        ...(threadId ? { [L_THREAD]: threadId } : {}),
      },
    });
    await this.engine.start(id);
    await this.waitReady(id);
    return this.augment(sandbox, id, false); // freshly created → cold
  }

  async teardown(sandbox: FeatureSandbox): Promise<void> {
    if (!sandbox.containerId) return;
    const info = await this.engine.inspect(sandbox.containerId);
    await this.engine.remove(sandbox.containerId, { force: true });
    if (info) {
      // The network + DinD volume share the container name stem; drop them so they don't accumulate.
      await this.cleanupArtifacts(info.name);
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
        await this.cleanupArtifacts(c.name);
        reaped++;
      }
    }
    if (reaped) this.logger.log(`reaped ${reaped} stopped sandbox(es)`);
    // Catch-all sweep for artifacts whose container is already gone (crashes / pre-fix leaks).
    await this.reapOrphanedArtifacts();
    return reaped;
  }

  /**
   * Reclaim FULLY ORPHANED sandbox artifacts — `atlas-sbx-*-net` networks and `atlas-sbx-*-dind`
   * volumes whose owning container no longer exists. {@link teardown}/{@link reapStopped} handle the
   * normal path; this is the catch-all for leaks from crashes, `kill -9`, or pre-fix runs (where
   * teardown dropped the container but not its network/volume). Each artifact's name stem is checked
   * against live container names, so one still attached to a container is never touched. Best-effort —
   * an unremovable artifact is logged and skipped. Returns how many of each were reclaimed.
   */
  async reapOrphanedArtifacts(): Promise<{ networks: number; volumes: number }> {
    const live = new Set((await this.engine.list({ all: true })).map((c) => c.name));
    const isOrphan = (name: string, suffix: string): boolean =>
      name.startsWith('atlas-sbx-') && name.endsWith(suffix) && !live.has(name.slice(0, -suffix.length));

    let networks = 0;
    for (const n of await this.engine.listNetworks()) {
      if (!isOrphan(n.name, '-net')) continue;
      try {
        await this.engine.removeNetwork(n.name);
        networks++;
      } catch (err) {
        this.logger.debug(`orphan network ${n.name} not removed: ${err}`);
      }
    }

    let volumes = 0;
    for (const v of await this.engine.listVolumes()) {
      if (!isOrphan(v.name, '-dind')) continue;
      try {
        await this.engine.removeVolume(v.name);
        volumes++;
      } catch (err) {
        this.logger.debug(`orphan volume ${v.name} not removed: ${err}`);
      }
    }

    if (networks || volumes) {
      this.logger.log(`reaped ${networks} orphan network(s) + ${volumes} orphan volume(s)`);
    }
    return { networks, volumes };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────

  private augment(sandbox: FeatureSandbox, containerId: string, warm: boolean): FeatureSandbox {
    const user = hostExecUser();
    return { ...sandbox, containerId, warm, ...(user ? { execUser: user } : {}) };
  }

  /**
   * Best-effort removal of a sandbox's per-container Docker artifacts: the `<name>-net` network and the
   * `<name>-dind` inner-docker volume (named off the container name in {@link attach}). MUST run AFTER
   * the container is removed — Docker refuses to drop a network/volume still attached/mounted. Never
   * throws: a missing or still-in-use artifact must not fail teardown (it's reclaimed on the next pass).
   */
  private async cleanupArtifacts(containerName: string): Promise<void> {
    const net = `${containerName}-net`;
    const vol = `${containerName}-dind`;
    await this.engine.removeNetwork(net).catch((err) => {
      this.logger.debug(`could not remove network ${net}: ${err}`);
    });
    await this.engine.removeVolume(vol).catch((err) => {
      this.logger.debug(`could not remove volume ${vol}: ${err}`);
    });
  }

  private agentHomeRootHost(): string {
    return (
      this.env.get('ATLAS_AGENT_HOME_ROOT') ??
      this.env.get('AGENT_HOME_ROOT') ??
      join(homedir(), '.agent-playground', 'atlas-agent-home')
    );
  }

  /** The per-tenant reference-library dir mounted read-only at /refs (undefined → no /refs). */
  private teamRefsDir(orgId: string): string | undefined {
    const root = this.env.get('ATLAS_REFS_ROOT') ?? this.env.get('REFS_ROOT');
    if (!root) return undefined;
    return join(root, orgId.replace(/[^a-z0-9_-]/gi, '_') || 'team');
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

  /**
   * Container name = `atlas-sbx-<team>-<project>-<key>`. For R2 threads the key is `thread-<id>` so the
   * container is STABLE across the thread's branch + re-attach (1 thread = 1 container). For the legacy
   * per-feature path + gate sandboxes (no `threadId`), the key is the branch — one container per branch,
   * unchanged.
   */
  private containerName(orgId: string, repoId: string, branch: string, threadId?: string): string {
    const part = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40);
    const key = threadId ? `thread-${part(threadId)}` : part(branch);
    return `atlas-sbx-${part(orgId)}-${part(repoId)}-${key}`.slice(0, 120);
  }
}
