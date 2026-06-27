import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chownSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { FeatureSandbox } from '../git';
import { engineBundlePath } from './bundle-engine';
import {
  CONTAINER_AGENT_HOME,
  CONTAINER_CONTEXT,
  CONTAINER_GIT_COMMON,
  CONTAINER_WORKTREE,
} from './docker-engine-runner';
import { CONTAINER_ENGINE, type ContainerEngine } from './container-engine.port';
import { hostExecUser } from './host-exec-user';
import { SandboxImageBuilder } from './sandbox-image.builder';
import type { SandboxAttachInput, SandboxProvider } from './sandbox-provider.port';

const execFileAsync = promisify(execFile);

/** The in-container path of the engine entrypoint baked by the Dockerfile — bind-mounted live over it. */
const CONTAINER_ENGINE_BUNDLE = '/usr/local/lib/atlas/engine-entrypoint.mjs';

/** realpath a path, falling back to the input if it can't be resolved (e.g. doesn't exist yet). */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Container-provisioning revision — bump when the container's CREATE config changes in a way that an
 * existing container must be recreated to pick up (new mounts, volumes, labels, privileges…). Combined
 * with the image id into the `atlas.cfg` fingerprint so a stale container is auto-recreated on its next
 * attach (the thread/worktree survive — only the disposable container is replaced). Engine-CODE changes
 * do NOT bump this: the engine bundle is bind-mounted live, so they're served on the next turn with no
 * recreate. (rev 2 = added the live engine-bundle mount. rev 3 = worktree mounted at /workspace + git common
 * dir at /repo.git, was same-path host paths. rev 4 = added the durable per-thread /context shared mount.
 * rev 6 = added per-repo worktree cache mounts from `.atlas/worktree.json`, folded into the fingerprint.)
 *
 * NOTE: the per-repo mount SET is ALSO hashed into the `atlas.cfg` fingerprint below, so a changed
 * manifest mount list recreates the container even without bumping this rev.
 */
const CONFIG_REV = 6;

/** Labels — the source of truth for boot adoption + reaping. */
const L_MANAGED = 'atlas.managed';
const L_TEAM = 'atlas.team';
const L_PROJECT = 'atlas.project';
const L_BRANCH = 'atlas.branch';
const L_THREAD = 'atlas.thread';
/** Fingerprint label: `<imageId>|cfg<rev>` — mismatch on attach ⇒ recreate the container. */
const L_CFG = 'atlas.cfg';

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

    const image = await this.images.ensureImage();
    // Fold the per-repo mount SET into the fingerprint so a changed `.atlas/worktree.json` mount list
    // recreates an existing (warm) container — binds are only applied at create time.
    const mountKey = (input.mounts ?? []).map((m) => `${m.path}:${m.mode}`).sort().join(',');
    const mountFp = mountKey ? createHash('sha256').update(mountKey).digest('hex').slice(0, 12) : 'none';
    const fingerprint = `${(await this.engine.imageId(image)) ?? 'noimg'}|cfg${CONFIG_REV}|m${mountFp}`;

    const existing = await this.engine.inspect(name);
    if (existing) {
      // STALE container — built from an older image or an older create-config (e.g. before the live
      // engine mount). Recreate it so the update lands; the thread/worktree are durable, so only the
      // disposable container is replaced (cold). Engine-CODE updates never reach here — the bind-mounted
      // bundle serves those live without a recreate.
      if (existing.labels[L_CFG] !== fingerprint) {
        this.logger.log(`recreating sandbox ${name} — stale (${existing.labels[L_CFG] ?? 'unstamped'} → ${fingerprint})`);
        await this.teardown(this.augment(sandbox, existing.id, false));
      } else {
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
    }

    await this.softCapCheck();

    const network = `${name}-net`;
    await this.engine.ensureNetwork(network);

    const hostHome = join(this.agentHomeRootHost(), 'sandboxes', name);
    mkdirSync(hostHome, { recursive: true });

    // The worktree mounts at a NEUTRAL container path (`/workspace`), not its host path — so the engine never
    // sees host-shaped paths. `cwd` is rewritten host→`/workspace` by the runner.
    const binds = [`${sandbox.worktreePath}:${CONTAINER_WORKTREE}`, `${hostHome}:${CONTAINER_AGENT_HOME}`];
    const gitDir = await this.gitCommonDir(sandbox.worktreePath);
    if (gitDir && !gitDir.startsWith(`${sandbox.worktreePath}/`)) {
      // Linked worktree: its `.git` lives OUTSIDE the worktree (the repo's shared common dir). Mount the
      // common dir at a neutral path too, then SHADOW the worktree's `.git` pointer file — which holds an
      // absolute HOST path — with a container-local one so in-container git resolves the worktree's gitdir
      // → objects/refs, without leaking host paths or mutating the host's real `.git` (the host still uses
      // it). `commondir` is already relative (`../..`), so it resolves to /repo.git unchanged.
      binds.push(`${gitDir}:${CONTAINER_GIT_COMMON}`);
      const dotGit = this.containerDotGit(sandbox.worktreePath, gitDir, hostHome);
      if (dotGit) binds.push(`${dotGit}:${CONTAINER_WORKTREE}/.git`);
    }
    // HOT-RELOAD: bind-mount the host engine bundle (read-only) over the baked-in one, so an engine
    // update (the API rebundles on boot) is picked up by the next `docker exec` in this container —
    // no recreate, no image rebuild. Falls back to the baked engine if the host bundle is absent.
    const bundle = engineBundlePath();
    if (existsSync(bundle)) {
      binds.push(`${bundle}:${CONTAINER_ENGINE_BUNDLE}:ro`);
    }
    // The host-maintained, READ-ONLY cross-repo reference library (per-tenant) at /refs.
    const refsDir = this.teamRefsDir(orgId);
    if (refsDir) {
      mkdirSync(refsDir, { recursive: true });
      binds.push(`${refsDir}:/refs:ro`);
    }
    // The thread's durable SHARED CONTEXT folder at /context — lives OUTSIDE the worktree (keyed by
    // threadId so it survives container recreate; the host reads it via contextDirHost()). THREE buckets,
    // pre-created so all always list cleanly:
    //   • specs/     — hand-authored by the brain (plan.md, diagrams). Read/write.
    //   • generated/ — SYSTEM-owned (decision-record.md, …), written ONLY by host tool calls. Mounted
    //                  READ-ONLY here (a nested :ro bind over the rw /context parent — Docker honors the
    //                  more-specific child mount) so no in-sandbox agent can edit a generated file.
    //   • artifacts/ — outputs for the human.
    const contextDir = this.contextDirHost(orgId, threadId, name);
    mkdirSync(join(contextDir, 'specs'), { recursive: true });
    mkdirSync(join(contextDir, 'generated'), { recursive: true });
    mkdirSync(join(contextDir, 'artifacts'), { recursive: true });
    binds.push(`${contextDir}:${CONTAINER_CONTEXT}`);
    binds.push(`${join(contextDir, 'generated')}:${CONTAINER_CONTEXT}/generated:ro`);

    // Per-repo CACHE MOUNTS from `.atlas/worktree.json` (resolved + validated by the WorktreeProvisioner).
    // Each lands at /workspace/<path>; per-thread gets its own host dir (no cross-thread write contention),
    // shared-ro mounts one immutable host dir read-only. Host dirs + the in-worktree mountpoint are
    // pre-created (+chowned to the host uid) so docker doesn't create them root-owned.
    binds.push(...this.cacheMountBinds(input));

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
        [L_CFG]: fingerprint,
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

  /**
   * Reclaim a thread's container by its DETERMINISTIC NAME — the terminal-cleanup counterpart to
   * {@link attach}, which resolves the SAME name (`atlas-sbx-<org>-<project>-thread-<id>`) regardless of
   * whether a `container_id` is currently known. This matters because `ThreadLifecycleService.reconcileOnBoot`
   * nulls a row's `container_id` on every restart while the real container keeps running; a close/delete
   * that happened before the thread's next turn would skip the id-gated {@link teardown} and LEAK the
   * container (and its `-net`/`-dind`) forever. If the container is already gone, its network/volume are
   * still reclaimed by name (cheap + idempotent). Never throws on a missing artifact.
   */
  async teardownByIdentity(input: SandboxAttachInput): Promise<void> {
    const { sandbox, orgId, threadId } = input;
    const name = this.containerName(orgId, sandbox.repoId, sandbox.branch, threadId);
    const existing = await this.engine.inspect(name);
    if (existing) {
      await this.engine.remove(existing.id, { force: true });
      await this.cleanupArtifacts(existing.name);
      this.logger.log(`tore down sandbox ${existing.name} (resolved by name)`);
    } else {
      // Container already gone — reclaim any net/vol that leaked off the same name stem (pre-fix runs).
      await this.cleanupArtifacts(name);
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
      this.env.get('AGENT_HOME_ROOT') ??
      join(homedir(), '.agent-playground', 'atlas-agent-home')
    );
  }

  /**
   * The HOST path of a thread's durable `/context` shared folder — the same dir bind-mounted into the
   * container at {@link CONTAINER_CONTEXT}. Keyed by `threadId` so it is STABLE across the container's
   * lifecycle (recreate, idle-reap, cold re-attach) and never deleted by container teardown (only by a
   * deep thread delete). The brain authors plan/track specs here and reads them back via this path;
   * the build sessions read it as shared context. Sandboxes WITHOUT a thread (legacy per-feature + gate
   * runs) fall back to a name-keyed dir — never resolved by the brain, just keeps the mount uniform.
   */
  contextDirHost(orgId: string, threadId?: string, name?: string): string {
    const root = join(this.agentHomeRootHost(), 'contexts');
    if (threadId) return join(root, orgId, threadId);
    return join(root, '_sandbox', name ?? 'unkeyed');
  }

  /**
   * Build the bind strings for the per-repo cache mounts AND pre-create their host dirs + in-worktree
   * mountpoints (chowned to the host uid so docker doesn't create them root-owned). per-thread caches get
   * their own host dir keyed by thread (or branch, for the legacy threadId-less path); shared-ro caches
   * share one read-only host dir per repo. The bind target is /workspace/<path>.
   */
  private cacheMountBinds(input: SandboxAttachInput): string[] {
    const mounts = input.mounts ?? [];
    if (!mounts.length) return [];
    const { sandbox, orgId, threadId } = input;
    const slug = sandbox.repoId.replace(/[^a-z0-9_-]/gi, '_') || 'repo';
    const safeOrg = orgId.replace(/[^a-z0-9_-]/gi, '_') || 'org';
    const perThreadKey = threadId ?? `_branch-${sandbox.branch.replace(/[^a-z0-9_-]/gi, '-')}`;
    const cacheRoot = join(this.agentHomeRootHost(), 'caches', safeOrg, slug);

    const binds: string[] = [];
    for (const m of mounts) {
      const hostDir =
        m.mode === 'shared-ro'
          ? join(cacheRoot, '_shared', m.path)
          : join(cacheRoot, perThreadKey, m.path);
      const mountpoint = join(sandbox.worktreePath, m.path);
      this.ensureHostOwnedDir(hostDir);
      this.ensureHostOwnedDir(mountpoint);
      const ro = m.mode === 'shared-ro' ? ':ro' : '';
      // Container path is POSIX under /workspace; manifest paths already use '/'.
      binds.push(`${hostDir}:${CONTAINER_WORKTREE}/${m.path}${ro}`);
    }
    return binds;
  }

  /** mkdir -p a dir and chown it to the host uid/gid (best-effort) so in-container writes stay host-owned. */
  private ensureHostOwnedDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
    if (uid !== undefined && gid !== undefined) {
      try {
        chownSync(dir, uid, gid);
      } catch {
        /* best-effort: we created it as ourselves anyway */
      }
    }
  }

  /** The per-tenant reference-library dir mounted read-only at /refs (undefined → no /refs). */
  private teamRefsDir(orgId: string): string | undefined {
    const root = this.env.get('REFS_ROOT');
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

  /**
   * Generate a container-local replacement for a linked worktree's `.git` pointer file. The real file
   * reads `gitdir: <hostCommon>/worktrees/<name>` — an absolute HOST path that isn't mounted in the box.
   * This writes the SAME pointer rebased onto {@link CONTAINER_GIT_COMMON} so in-container git resolves
   * the worktree's gitdir. Returns the host path of the generated file (to bind-mount over the worktree's
   * `.git`), or undefined if the worktree `.git` can't be read/parsed.
   */
  private containerDotGit(worktreePath: string, commonDir: string, hostHome: string): string | undefined {
    try {
      const raw = readFileSync(join(worktreePath, '.git'), 'utf8').trim();
      const m = raw.match(/^gitdir:\s*(.+)$/);
      if (!m) return undefined;
      // Realpath-normalize BOTH operands before diffing. `git --git-common-dir` returns a realpath'd
      // absolute path, but the `.git` pointer's stored gitdir may use a symlinked form (on macOS the OS
      // tmp/repos root is `/var/folders/…` → `/private/var/folders/…`). Without normalizing, `relative()`
      // yields a bogus `../../…` and we'd bail, leaving no in-container `.git` → "not a git repository".
      const rel = relative(realpathSafe(commonDir), realpathSafe(m[1].trim())); // e.g. "worktrees/thread-X"
      if (!rel || rel.startsWith('..')) return undefined; // gitdir not under the common dir — bail safely
      const file = join(hostHome, 'worktree.git');
      writeFileSync(file, `gitdir: ${CONTAINER_GIT_COMMON}/${rel}\n`);
      return file;
    } catch {
      return undefined;
    }
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
    const cap = this.env.get('MAX_CONCURRENT_SANDBOXES');
    if (!cap) return;
    const running = (await this.engine.list({ label: `${L_MANAGED}=1`, all: false })).length;
    if (running >= cap) {
      this.logger.warn(`live sandboxes (${running}) at/over MAX_CONCURRENT_SANDBOXES (${cap}) — reaping stopped`);
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
