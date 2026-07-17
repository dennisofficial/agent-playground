import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { atlasAgentHomeBase } from '../../_shared/engine/engine-home';
import type { ResolvedMcpServer } from '../../_shared/engine/engine.types';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { managedGitSkillsRootHost, orgSkillsRootHost } from '../skills/skill-store-paths';
import { managedSkillsRootHost } from '../skills/system-skill-store-paths';
import {
  engineAppBundlePath,
  engineAppMapPath,
  mcpBridgeBundlePath,
  mcpHubBundlePath,
} from './bundle-engine';
import { CONTAINER_ENGINE, type ContainerEngine } from './container-engine.port';
import {
  CONTAINER_AGENT_HOME,
  CONTAINER_CONTEXT,
  CONTAINER_FNM_STORE,
  CONTAINER_GIT_COMMON,
  CONTAINER_HOME,
  CONTAINER_MCP_HUB_CONFIG,
  CONTAINER_MCP_HUB_DIR,
  CONTAINER_PLAYGROUND,
  CONTAINER_PNPM_STORE,
  CONTAINER_SKILLS_MANAGED,
  CONTAINER_SKILLS_MANAGED_GIT,
  CONTAINER_SKILLS_STORE,
  CONTAINER_WORKTREE,
  GITHUB_TOKEN_FILE,
  isExternalMountPath,
  isReservedContainerPath,
} from './container-paths';
import { hostExecUser } from './host-exec-user';
import type { McpHubConfig } from './image/mcp-hub-config';
import { SandboxImageBuilder } from './sandbox-image.builder';
import type {
  SandboxAttachInput,
  SandboxProvider,
  ServiceLivenessProbe,
  SetupScriptResult,
} from './sandbox-provider.port';
import { CaddyAdminClient } from '../exposure/caddy-admin.client';
import { previewId, routePrefix } from '../exposure/exposure-naming';
import { FeatureSandbox } from '../git/local-git.service';

const execFileAsync = promisify(execFile);

const CONTAINER_ENGINE_APP = '/usr/local/lib/atlas/engine-app.js';
const CONTAINER_ENGINE_APP_MAP = '/usr/local/lib/atlas/engine-app.js.map';
const CONTAINER_MCP_BRIDGE_BUNDLE = '/usr/local/lib/atlas/mcp-bridge-server.mjs';
const CONTAINER_MCP_HUB_BUNDLE = '/usr/local/lib/atlas/mcp-hub-server.mjs';

const PROBE_TIMEOUT_MS = 4_000;

const DELIVER_TIMEOUT_MS = 15_000;

const SETUP_SCRIPT_TIMEOUT_MS = 300_000;

const SETUP_SCRIPT_TAIL_BYTES = 2_000;

const CREATE_GRACE_MS = 5 * 60 * 1000;

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function rebaseDotGit(
  gitPointerPath: string,
  commonDir: string,
  outFile: string,
): string | undefined {
  try {
    const raw = readFileSync(gitPointerPath, 'utf8').trim();
    const m = raw.match(/^gitdir:\s*(.+)$/);
    if (!m) return undefined;
    const gitdir = m[1].trim();
    const abs = isAbsolute(gitdir) ? gitdir : resolve(dirname(gitPointerPath), gitdir);
    const rel = relative(realpathSafe(commonDir), realpathSafe(abs)); // e.g. "worktrees/thread-X"
    if (!rel || rel.startsWith('..')) return undefined; // gitdir not under the common dir — bail safely
    writeFileSync(outFile, `gitdir: ${CONTAINER_GIT_COMMON}/${rel}\n`);
    return outFile;
  } catch {
    return undefined;
  }
}

export function submoduleGitlinks(worktreePath: string): string[] {
  const out: string[] = [];
  const visit = (relBase: string): void => {
    const modulesFile = join(worktreePath, relBase, '.gitmodules');
    if (!existsSync(modulesFile)) return;
    let content: string;
    try {
      content = readFileSync(modulesFile, 'utf8');
    } catch {
      return;
    }
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const rel = relBase ? `${relBase}/${m[1]}` : m[1];
      out.push(rel);
      visit(rel); // recurse into nested submodules
    }
  };
  visit('');
  return out;
}

const CONFIG_REV = 16;

const L_MANAGED = 'atlas.managed';
const L_TEAM = 'atlas.team';
const L_PROJECT = 'atlas.project';
const L_BRANCH = 'atlas.branch';
const L_THREAD = 'atlas.thread';
const L_CFG = 'atlas.cfg';


export function dedupeBindsByTarget(binds: string[]): {
  binds: string[];
  dropped: string[];
} {
  const byTarget = new Map<string, string>();
  const dropped: string[] = [];
  for (const b of binds) {
    const target = b.split(':')[1] ?? b;
    if (byTarget.has(target)) dropped.push(target);
    byTarget.set(target, b); // last wins → system binds override a colliding cache mount
  }
  return { binds: [...byTarget.values()], dropped };
}

@Injectable()
export class SandboxManager implements SandboxProvider {
  private readonly logger = new Logger(SandboxManager.name);

  private readonly creating = new Map<string, number>();

  constructor(
    @Inject(CONTAINER_ENGINE) private readonly engine: ContainerEngine,
    private readonly images: SandboxImageBuilder,
    private readonly env: EnvService,
    @Optional() private readonly caddy?: CaddyAdminClient,
  ) {}

  async attach(input: SandboxAttachInput): Promise<FeatureSandbox> {
    const { sandbox, orgId, jobId } = input;
    const name = this.containerName(orgId, sandbox.repoId, sandbox.branch, jobId);

    const image = await this.images.ensureImage(
      input.onMilestone ? () => input.onMilestone!('image_build') : undefined,
    );
    const mountKey = (input.mounts ?? [])
      .map((m) => `${m.path}:${m.mode}`)
      .sort()
      .join(',');
    const mountFp = mountKey
      ? createHash('sha256').update(mountKey).digest('hex').slice(0, 12)
      : 'none';
    const scriptFp = input.setupScript
      ? createHash('sha256').update(input.setupScript).digest('hex').slice(0, 12)
      : 'none';
    const fingerprint = `${(await this.engine.imageId(image)) ?? 'noimg'}|cfg${CONFIG_REV}|m${mountFp}|s${scriptFp}`;

    const existing = await this.engine.inspect(name);
    if (existing) {
      if (existing.labels[L_CFG] !== fingerprint) {
        this.logger.log(
          `recreating sandbox ${name} — stale (${existing.labels[L_CFG] ?? 'unstamped'} → ${fingerprint})`,
        );
        await this.teardown(this.augment(sandbox, existing.id, false));
      } else {
        const warm = existing.state === 'running';
        if (!warm) {
          this.logger.log(`reusing stopped sandbox ${name} — starting (cold)`);
          await this.engine.start(existing.id);
          await this.attachRedisBus(existing.id); // idempotent — re-ensure the redis bus after a restart
          await this.waitReady(existing.id);
        } else {
          this.logger.log(`reusing running sandbox ${name}`);
        }
        return this.applySetupScript(
          this.augment(sandbox, existing.id, warm),
          existing.id,
          warm ? null : input.setupScript,
        );
      }
    }

    this.creating.set(name, Date.now());

    const network = `${name}-net`;
    await this.engine.ensureNetwork(network);

    const hostHome = join(this.agentHomeRootHost(), 'sandboxes', name);
    mkdirSync(hostHome, { recursive: true });
    for (const child of ['pnpm-store', 'fnm', 'git-common']) {
      mkdirSync(join(hostHome, child), { recursive: true });
    }

    const binds = [
      `${sandbox.worktreePath}:${CONTAINER_WORKTREE}`,
      `${hostHome}:${CONTAINER_AGENT_HOME}`,
    ];
    const gitDir = await this.gitCommonDir(sandbox.worktreePath);
    const gitDirInsideWorktree =
      !!gitDir && realpathSafe(gitDir).startsWith(`${realpathSafe(sandbox.worktreePath)}/`);
    if (gitDir && !gitDirInsideWorktree) {
      binds.push(`${gitDir}:${CONTAINER_GIT_COMMON}`);
      const dotGit = rebaseDotGit(
        join(sandbox.worktreePath, '.git'),
        gitDir,
        join(hostHome, 'worktree.git'),
      );
      if (dotGit) binds.push(`${dotGit}:${CONTAINER_WORKTREE}/.git`);

      for (const sub of submoduleGitlinks(sandbox.worktreePath)) {
        const ptr = join(sandbox.worktreePath, sub, '.git');
        if (!existsSync(ptr) || !statSync(ptr).isFile()) continue;
        const out = join(hostHome, `submodule-${sub.replace(/\//g, '__')}.git`);
        const rebased = rebaseDotGit(ptr, gitDir, out);
        if (rebased) binds.push(`${rebased}:${CONTAINER_WORKTREE}/${sub}/.git`);
      }
    }
    const engineApp = engineAppBundlePath();
    if (existsSync(engineApp)) {
      binds.push(`${engineApp}:${CONTAINER_ENGINE_APP}:ro`);
    }
    const engineAppMap = engineAppMapPath();
    if (existsSync(engineAppMap)) {
      binds.push(`${engineAppMap}:${CONTAINER_ENGINE_APP_MAP}:ro`);
    }
    const mcpBridge = mcpBridgeBundlePath();
    if (existsSync(mcpBridge)) {
      binds.push(`${mcpBridge}:${CONTAINER_MCP_BRIDGE_BUNDLE}:ro`);
    }
    const mcpHub = mcpHubBundlePath();
    if (existsSync(mcpHub)) {
      binds.push(`${mcpHub}:${CONTAINER_MCP_HUB_BUNDLE}:ro`);
    }
    const refsDir = this.teamRefsDir(orgId);
    if (refsDir) {
      mkdirSync(refsDir, { recursive: true });
      binds.push(`${refsDir}:/refs:ro`);
    }
    const skillsDir = this.orgSkillsDir(orgId);
    mkdirSync(skillsDir, { recursive: true });
    binds.push(`${skillsDir}:${CONTAINER_SKILLS_STORE}`);
    const managedSkillsDir = managedSkillsRootHost();
    if (existsSync(managedSkillsDir)) {
      binds.push(`${managedSkillsDir}:${CONTAINER_SKILLS_MANAGED}:ro`);
    }
    const managedGitSkillsDir = managedGitSkillsRootHost(this.env.get('SKILLS_ROOT'));
    mkdirSync(managedGitSkillsDir, { recursive: true });
    binds.push(`${managedGitSkillsDir}:${CONTAINER_SKILLS_MANAGED_GIT}:ro`);
    const contextDir = this.contextDirHost(orgId, jobId, name);
    mkdirSync(join(contextDir, 'specs'), { recursive: true });
    mkdirSync(join(contextDir, 'generated'), { recursive: true });
    mkdirSync(join(contextDir, 'artifacts'), { recursive: true });
    mkdirSync(join(contextDir, 'evidence'), { recursive: true }); // read-write like artifacts (no nested :ro bind; inherits the /context rw parent)
    binds.push(`${contextDir}:${CONTAINER_CONTEXT}`);
    binds.push(`${join(contextDir, 'generated')}:${CONTAINER_CONTEXT}/generated:ro`);

    const playgroundDir = this.playgroundDirHost(orgId, jobId, name);
    this.ensureHostOwnedDir(playgroundDir);
    binds.push(`${playgroundDir}:${CONTAINER_PLAYGROUND}`);

    const safeOrg = orgId.replace(/[^a-z0-9_-]/gi, '_') || 'org';
    const slug = sandbox.repoId.replace(/[^a-z0-9_-]/gi, '_') || 'repo';
    const homeDir = join(this.agentHomeRootHost(), 'caches', safeOrg, slug, '_home');
    this.ensureHostOwnedDir(homeDir);
    binds.push(`${homeDir}:${CONTAINER_HOME}`);

    binds.push(...this.cacheMountBinds(input));

    const pnpmStore = join(this.agentHomeRootHost(), 'pnpm-store');
    this.ensureHostOwnedDir(pnpmStore);
    binds.push(`${pnpmStore}:${CONTAINER_PNPM_STORE}`);

    const fnmStore = join(this.agentHomeRootHost(), 'fnm-store');
    this.ensureHostOwnedDir(fnmStore);
    binds.push(`${fnmStore}:${CONTAINER_FNM_STORE}`);

    input.onMilestone?.('container_create');
    this.logger.log(`creating sandbox ${name} (image ${image}, net ${network})`);
    const containerEnv: Record<string, string> = {};
    const agentNice = this.env.get('SANDBOX_AGENT_NICE');
    if (agentNice !== undefined) containerEnv.ATLAS_AGENT_NICE = String(agentNice);
    if (this.previewEnabled() && jobId) {
      containerEnv.ATLAS_PREVIEW_ID = previewId(jobId, this.previewSecret());
      containerEnv.ATLAS_PREVIEW_DOMAIN = this.env.get('PREVIEW_BASE_DOMAIN')!;
    }

    const id = await this.engine.createContainer({
      name,
      image,
      network,
      privileged: true,
      init: true,
      cpuShares: this.env.get('SANDBOX_CPU_SHARES'),
      ...(this.env.get('SANDBOX_MAX_CPUS') !== undefined
        ? { nanoCpus: Math.round(this.env.get('SANDBOX_MAX_CPUS')! * 1e9) }
        : {}),
      memoryBytes: (this.env.get('SANDBOX_MAX_MEMORY_GB') ?? 24) * 1024 ** 3,
      pidsLimit: this.env.get('SANDBOX_MAX_PIDS') ?? 8192,
      binds: this.dedupeBindsByTarget(binds),
      volumes: [{ name: `${name}-dind`, path: '/var/lib/docker' }],
      ...(Object.keys(containerEnv).length ? { env: containerEnv } : {}),
      labels: {
        [L_MANAGED]: '1',
        [L_TEAM]: orgId,
        [L_PROJECT]: sandbox.repoId,
        [L_BRANCH]: sandbox.branch,
        [L_CFG]: fingerprint,
        ...(jobId ? { [L_THREAD]: jobId } : {}),
      },
    });
    await this.engine.start(id);
    await this.attachRedisBus(id);
    await this.waitReady(id);
    return this.applySetupScript(this.augment(sandbox, id, false), id, input.setupScript);
  }

  private async attachRedisBus(containerId: string): Promise<void> {
    const bus = this.env.get('SANDBOX_BUS_NETWORK');
    if (!bus) return;
    await this.engine.ensureNetwork(bus);
    await this.engine.connectNetwork(containerId, bus);
  }

  sandboxContainerName(jobId: string): string {
    return this.containerName('', '', '', jobId);
  }

  async bridgeCaddyToSandbox(jobId: string): Promise<void> {
    if (!this.previewEnabled()) return;
    await this.engine.connectNetwork(
      this.caddyContainer(),
      `${this.containerName('', '', '', jobId)}-net`,
    );
  }

  async unbridgeCaddyFromSandbox(jobId: string): Promise<void> {
    if (!this.previewEnabled()) return;
    await this.engine.disconnectNetwork(
      this.caddyContainer(),
      `${this.containerName('', '', '', jobId)}-net`,
    );
  }

  async listLiveThreadJobIds(): Promise<string[]> {
    const cs = await this.engine.list({ label: `${L_MANAGED}=1`, all: false });
    const prefix = 'atlas-sbx-thread-';
    return cs
      .map((c) => c.name)
      .filter((n) => n.startsWith(prefix))
      .map((n) => n.slice(prefix.length));
  }

  async teardown(sandbox: FeatureSandbox): Promise<void> {
    if (!sandbox.containerId) return;
    const info = await this.engine.inspect(sandbox.containerId);
    await this.engine.remove(sandbox.containerId, { force: true });
    if (info) {
      await this.cleanupArtifacts(info.name);
      this.logger.log(`tore down sandbox ${info.name}`);
    }
  }

  async teardownByIdentity(input: SandboxAttachInput): Promise<void> {
    const { sandbox, orgId, jobId } = input;
    const name = this.containerName(orgId, sandbox.repoId, sandbox.branch, jobId);
    const existing = await this.engine.inspect(name);
    if (existing) {
      await this.engine.remove(existing.id, { force: true });
      await this.cleanupArtifacts(existing.name);
      this.logger.log(`tore down sandbox ${existing.name} (resolved by name)`);
    } else {
      await this.cleanupArtifacts(name);
    }
  }

  async reapOrphanedArtifacts(): Promise<{
    networks: number;
    volumes: number;
  }> {
    const live = new Set((await this.engine.list({ all: true })).map((c) => c.name));
    const now = Date.now();
    for (const [stem, at] of this.creating) {
      if (now - at >= CREATE_GRACE_MS) this.creating.delete(stem);
    }
    const isCreating = (stem: string): boolean =>
      now - (this.creating.get(stem) ?? 0) < CREATE_GRACE_MS;
    const isOrphan = (name: string, suffix: string): boolean => {
      if (!name.startsWith('atlas-sbx-') || !name.endsWith(suffix)) return false;
      const stem = name.slice(0, -suffix.length);
      return !live.has(stem) && !isCreating(stem);
    };

    let networks = 0;
    for (const n of await this.engine.listNetworks()) {
      if (!isOrphan(n.name, '-net')) continue;
      try {
        await this.removeSandboxNet(n.name);
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


  private augment(sandbox: FeatureSandbox, containerId: string, warm: boolean): FeatureSandbox {
    const user = hostExecUser();
    return {
      ...sandbox,
      containerId,
      warm,
      ...(user ? { execUser: user } : {}),
    };
  }

  private async applySetupScript(
    fs: FeatureSandbox,
    containerId: string,
    script: string | null | undefined,
  ): Promise<FeatureSandbox> {
    if (!script) return fs;
    return {
      ...fs,
      setupScriptResult: await this.runSetupScript(containerId, script),
    };
  }

  private async runSetupScript(containerId: string, script: string): Promise<SetupScriptResult> {
    const user = hostExecUser();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SETUP_SCRIPT_TIMEOUT_MS);
    let out = '';
    const capture = (chunk: string) => {
      out = (out + chunk).slice(-SETUP_SCRIPT_TAIL_BYTES);
    };
    try {
      const res = await this.engine.exec(containerId, ['bash', '-c', script], {
        cwd: CONTAINER_WORKTREE,
        ...(user ? { user } : {}),
        onStdout: capture,
        onStderr: capture,
        signal: ctrl.signal,
      });
      const ok = res.exitCode === 0;
      this.logger[ok ? 'log' : 'warn'](
        `setup script on ${containerId.slice(0, 12)} exited ${res.exitCode}`,
      );
      return { ok, exitCode: res.exitCode, tail: out.trim() };
    } catch (err) {
      const aborted = ctrl.signal.aborted;
      this.logger.warn(
        `setup script on ${containerId.slice(0, 12)} failed: ${aborted ? 'timeout' : String(err)}`,
      );
      const tail = (
        aborted
          ? `setup script timed out after ${SETUP_SCRIPT_TIMEOUT_MS}ms\n${out}`
          : `setup script exec error: ${String(err)}\n${out}`
      ).trim();
      return {
        ok: false,
        exitCode: -1,
        tail: tail.slice(-SETUP_SCRIPT_TAIL_BYTES),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async cleanupArtifacts(containerName: string): Promise<void> {
    const net = `${containerName}-net`;
    const vol = `${containerName}-dind`;
    await this.removeSandboxNet(net).catch((err) => {
      this.logger.debug(`could not remove network ${net}: ${err}`);
    });
    await this.engine.removeVolume(vol).catch((err) => {
      this.logger.debug(`could not remove volume ${vol}: ${err}`);
    });
  }

  private async removeSandboxNet(netName: string): Promise<void> {
    const m = netName.match(/^atlas-sbx-thread-(.+)-net$/);
    if (m && this.caddy && this.previewEnabled()) {
      const jobId = m[1];
      await this.caddy
        .deleteRoutesByPrefix(routePrefix(jobId, this.previewSecret()))
        .catch(() => undefined);
      await this.engine.disconnectNetwork(this.caddyContainer(), netName).catch(() => undefined);
    }
    await this.engine.removeNetwork(netName);
  }

  private previewEnabled(): boolean {
    return !!this.env.get('PREVIEW_BASE_DOMAIN');
  }

  private caddyContainer(): string {
    return this.env.get('CADDY_CONTAINER_NAME') ?? 'atlas-caddy';
  }

  private previewSecret(): string {
    return this.env.get('PREVIEW_ID_SECRET') ?? this.env.get('SECRETS_ENCRYPTION_KEY');
  }

  private agentHomeRootHost(): string {
    return atlasAgentHomeBase(this.env.get('AGENT_HOME_ROOT'));
  }

  brainTranscriptProjectsDir(jobId: string): string | null {
    const sandboxHome = this.findSandboxHomeDir(jobId);
    if (!sandboxHome) return null;
    const jobHome = this.findJobHomeDir(sandboxHome, jobId);
    if (!jobHome) return null;
    const brainHome = join(jobHome, 'brain');
    return existsSync(brainHome) ? join(brainHome, 'claude', 'projects') : null;
  }

  private findJobHomeDir(sandboxHome: string, jobId: string): string | null {
    const orgDir = this.soleSubdir(sandboxHome);
    if (!orgDir) return null;
    const repoDir = this.soleSubdir(join(sandboxHome, orgDir));
    if (!repoDir) return null;
    const jobHome = join(sandboxHome, orgDir, repoDir, jobId);
    return existsSync(jobHome) ? jobHome : null;
  }

  private soleSubdir(dir: string): string | null {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    return entries.length === 1 ? entries[0]! : null;
  }

  supervisorDirHost(jobId: string): string | null {
    const sandboxHome = this.findSandboxHomeDir(jobId);
    return sandboxHome ? join(sandboxHome, 'supervisor') : null;
  }

  async probeLiveness(jobId: string, pgids: number[]): Promise<ServiceLivenessProbe> {
    try {
      const name = this.containerName('', '', '', jobId);
      const info = await this.engine.inspect(name);
      if (!info || info.state !== 'running' || !info.startedAt) return { status: 'down' };

      const valid = pgids.filter((g) => Number.isInteger(g) && g > 0);
      if (valid.length === 0)
        return { status: 'up', containerStartedAt: info.startedAt, alive: [] };

      const script = `for g in ${valid.join(' ')}; do kill -0 -"$g" 2>/dev/null && echo "$g"; done`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      let out: { exitCode: number; stdout: string };
      try {
        out = await this.engine.exec(info.id, ['sh', '-c', script], {
          ...(hostExecUser() ? { user: hostExecUser() } : {}),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const alive = out.stdout
        .split('\n')
        .map((l) => Number.parseInt(l.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0);
      return { status: 'up', containerStartedAt: info.startedAt, alive };
    } catch (err) {
      this.logger.warn(
        `probeLiveness(${jobId.slice(0, 8)}) failed — reporting unknown: ${String(err)}`,
      );
      return { status: 'unknown' };
    }
  }

  async kickMcpHubRefresh(input: { jobId: string; servers: ResolvedMcpServer[] }): Promise<void> {
    try {
      const name = this.containerName('', '', '', input.jobId);
      const hostHome = join(this.agentHomeRootHost(), 'sandboxes', name);
      mkdirSync(hostHome, { recursive: true });

      const [uidStr, gidStr] = (hostExecUser() ?? '').split(':');
      const uid = Number.parseInt(uidStr ?? '', 10);
      const gid = Number.parseInt(gidStr ?? '', 10);
      const config: McpHubConfig = {
        spawn: {
          ...(Number.isInteger(uid) ? { uid } : {}),
          ...(Number.isInteger(gid) ? { gid } : {}),
          cwd: CONTAINER_WORKTREE,
          home: CONTAINER_HOME,
          baseEnv: {
            PATH: '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
            LANG: 'C.UTF-8',
          },
        },
        servers: input.servers,
      };
      writeFileSync(join(hostHome, basename(CONTAINER_MCP_HUB_CONFIG)), JSON.stringify(config), {
        mode: 0o600,
      });

      const info = await this.engine.inspect(name);
      if (!info || info.state !== 'running') return; // hub reads the file on its next boot
      await this.engine.execDetached(
        info.id,
        [
          'sh',
          '-c',
          `kill -HUP "$(cat "${CONTAINER_MCP_HUB_DIR}/hub.pid" 2>/dev/null)" 2>/dev/null || true`,
        ],
        { ...(hostExecUser() ? { user: hostExecUser() } : {}) },
      );
    } catch (err) {
      this.logger.debug(`kickMcpHubRefresh(${input.jobId.slice(0, 8)}) skipped: ${String(err)}`);
    }
  }

  async writeGithubTokenFile(jobId: string, token: string): Promise<void> {
    const name = this.containerName('', '', '', jobId);
    const hostHome = join(this.agentHomeRootHost(), 'sandboxes', name);
    mkdirSync(hostHome, { recursive: true });
    const dest = join(hostHome, basename(GITHUB_TOKEN_FILE));
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, token, { mode: 0o600 });
    renameSync(tmp, dest);
  }

  async writeToJobContainerPath(input: {
    jobId: string;
    path: string;
    value: string;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; reason?: string }> {
    const name = this.containerName('', '', '', input.jobId);
    const info = await this.engine.inspect(name);
    if (!info || info.state !== 'running') {
      return { ok: false, reason: 'the sandbox container is not running' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? DELIVER_TIMEOUT_MS);
    try {
      const out = await this.engine.exec(info.id, ['sh', '-c', 'cat > "$1"', 'sh', input.path], {
        ...(hostExecUser() ? { user: hostExecUser() } : {}),
        stdin: input.value,
        signal: ctrl.signal,
      });
      if (out.exitCode !== 0) {
        return { ok: false, reason: `delivery exited ${out.exitCode}` };
      }
      return { ok: true };
    } catch {
      return {
        ok: false,
        reason: 'delivery timed out — the target process is not reading',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async stopAllServices(jobId: string): Promise<{ ok: boolean; reason?: string }> {
    const name = this.containerName('', '', '', jobId);
    const info = await this.engine.inspect(name);
    if (!info || info.state !== 'running') {
      return { ok: false, reason: 'the sandbox container is not running' };
    }
    try {
      const out = await this.engine.exec(info.id, ['/usr/local/bin/atlas-svc', 'stop-all'], {
        ...(hostExecUser() ? { user: hostExecUser() } : {}),
      });
      return out.exitCode === 0
        ? { ok: true }
        : { ok: false, reason: `atlas-svc stop-all exited ${out.exitCode}` };
    } catch (err) {
      return { ok: false, reason: `atlas-svc stop-all failed: ${String(err)}` };
    }
  }

  private findSandboxHomeDir(jobId: string): string | null {
    const sandboxesRoot = join(this.agentHomeRootHost(), 'sandboxes');
    let dirs: string[];
    try {
      dirs = readdirSync(sandboxesRoot);
    } catch {
      return null; // no sandboxes provisioned yet
    }
    const sandboxDir = dirs.find((d) => {
      const i = d.lastIndexOf('-thread-');
      if (i < 0) return false; // gate sandbox keyed by branch — not a thread sandbox
      const suffix = d.slice(i + '-thread-'.length);
      return suffix.length > 0 && jobId.startsWith(suffix);
    });
    return sandboxDir ? join(sandboxesRoot, sandboxDir) : null;
  }

  contextDirHost(orgId: string, jobId?: string, name?: string): string {
    const root = join(this.agentHomeRootHost(), 'contexts');
    if (jobId) return join(root, orgId, jobId);
    return join(root, '_sandbox', name ?? 'unkeyed');
  }

  playgroundDirHost(orgId: string, jobId?: string, name?: string): string {
    const root = join(this.agentHomeRootHost(), 'playgrounds');
    if (jobId) return join(root, orgId, jobId);
    return join(root, '_sandbox', name ?? 'unkeyed');
  }

  draftUploadsDirHost(orgId: string, jobId: string, userId: string): string {
    return join(this.agentHomeRootHost(), 'draft-uploads', orgId, jobId, userId);
  }

  private cacheMountBinds(input: SandboxAttachInput): string[] {
    const mounts = input.mounts ?? [];
    if (!mounts.length) return [];
    const { sandbox, orgId, jobId } = input;
    const slug = sandbox.repoId.replace(/[^a-z0-9_-]/gi, '_') || 'repo';
    const safeOrg = orgId.replace(/[^a-z0-9_-]/gi, '_') || 'org';
    const perThreadKey = jobId ?? `_branch-${sandbox.branch.replace(/[^a-z0-9_-]/gi, '-')}`;
    const cacheRoot = join(this.agentHomeRootHost(), 'caches', safeOrg, slug);

    const binds: string[] = [];
    for (const m of mounts) {
      const tier =
        m.mode === 'shared-ro' ? '_shared' : m.mode === 'shared-rw' ? '_shared-rw' : perThreadKey;
      const ro = m.mode === 'shared-ro' ? ':ro' : '';
      const external = isExternalMountPath(m.path);
      if (external && isReservedContainerPath(m.path)) continue;
      const hostDir = external
        ? join(cacheRoot, tier, '_ext', m.path.replace(/^\/+/, ''))
        : join(cacheRoot, tier, m.path);
      this.ensureHostOwnedDir(hostDir);
      if (m.mode === 'shared-rw') {
        try {
          chmodSync(hostDir, 0o700);
        } catch {
        }
      }
      if (external) {
        binds.push(`${hostDir}:${m.path}${ro}`);
        continue;
      }
      this.ensureHostOwnedDir(join(sandbox.worktreePath, m.path));
      binds.push(`${hostDir}:${CONTAINER_WORKTREE}/${m.path}${ro}`);
    }
    return binds;
  }

  private dedupeBindsByTarget(binds: string[]): string[] {
    const { binds: deduped, dropped } = dedupeBindsByTarget(binds);
    if (dropped.length) {
      this.logger.warn(
        `dropped ${dropped.length} duplicate sandbox mount target(s): ` +
          `${[...new Set(dropped)].join(', ')} (system bind wins)`,
      );
    }
    return deduped;
  }

  private ensureHostOwnedDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
    if (uid !== undefined && gid !== undefined) {
      try {
        chownSync(dir, uid, gid);
      } catch {
      }
    }
  }

  private teamRefsDir(orgId: string): string | undefined {
    const root = this.env.get('REFS_ROOT');
    if (!root) return undefined;
    return join(root, orgId.replace(/[^a-z0-9_-]/gi, '_') || 'team');
  }

  private orgSkillsDir(orgId: string): string {
    return orgSkillsRootHost(this.env.get('SKILLS_ROOT'), orgId);
  }

  private async waitReady(containerId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.engine
        .exec(containerId, ['docker', 'info', '--format', '{{.ServerVersion}}'])
        .catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
      if (r.exitCode === 0 && r.stdout.trim()) return;
      await new Promise((res) => setTimeout(res, 1000));
    }
    this.logger.warn(
      `sandbox ${containerId.slice(0, 12)} inner dockerd not ready in ${timeoutMs}ms — continuing`,
    );
  }

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

  private containerName(orgId: string, repoId: string, branch: string, jobId?: string): string {
    const part = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40);
    if (jobId) return `atlas-sbx-thread-${part(jobId)}`;
    return `atlas-sbx-${part(orgId)}-${part(repoId)}-${part(branch)}`.slice(0, 120);
  }
}
