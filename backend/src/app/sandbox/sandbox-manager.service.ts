import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { atlasAgentHomeBase } from '../engine/engine-home';
import type { FeatureSandbox } from '../git';
import { managedGitSkillsRootHost, orgSkillsRootHost } from '../skills/skill-store-paths';
import { managedSkillsRootHost } from '../skills/system-skill-store-paths';
import { engineBundlePath, mcpBridgeBundlePath, mcpHubBundlePath } from './bundle-engine';
import {
  CONTAINER_AGENT_HOME,
  CONTAINER_CONTEXT,
  CONTAINER_FNM_STORE,
  CONTAINER_GIT_COMMON,
  CONTAINER_HOME,
  CONTAINER_MCP_HUB_CONFIG,
  CONTAINER_MCP_HUB_DIR,
  CONTAINER_PLAYGROUND,
  GITHUB_TOKEN_FILE,
  CONTAINER_PNPM_STORE,
  CONTAINER_SKILLS_MANAGED,
  CONTAINER_SKILLS_MANAGED_GIT,
  CONTAINER_SKILLS_STORE,
  CONTAINER_WORKTREE,
  isExternalMountPath,
  isReservedContainerPath,
} from './container-paths';
import type { ResolvedMcpServer } from '../engine/engine.types';
import type { McpHubConfig } from './image/mcp-hub-config';
import { CONTAINER_ENGINE, type ContainerEngine } from './container-engine.port';
import { hostExecUser } from './host-exec-user';
import { isAtlasRepo } from './atlas-repo';
import { SandboxImageBuilder } from './sandbox-image.builder';
import type { SandboxAttachInput, SandboxProvider, ServiceLivenessProbe, SetupScriptResult } from './sandbox-provider.port';
// Narrow sub-path imports (NOT the '../exposure' barrel) so the sandbox layer takes no dependency on
// ExposureService — which itself imports the sandbox port — avoiding an import cycle.
import { CaddyAdminClient } from '../exposure/caddy-admin.client';
import { previewId, routePrefix } from '../exposure/exposure-naming';

const execFileAsync = promisify(execFile);

/** The in-container path of the engine entrypoint baked by the Dockerfile — bind-mounted live over it. */
const CONTAINER_ENGINE_BUNDLE = '/usr/local/lib/atlas/engine-entrypoint.mjs';
/** The in-container path of the Codex MCP tool-bridge server (spawned by codex via config.toml). Baked by
 *  the Dockerfile, bind-mounted live over it — same hot-reload contract as the engine bundle. */
const CONTAINER_MCP_BRIDGE_BUNDLE = '/usr/local/lib/atlas/mcp-bridge-server.mjs';
/** The in-container path of the persistent MCP hub (launched by `sandbox-init.sh`). Baked by the Dockerfile,
 *  bind-mounted live over it — same hot-reload contract as the engine bundle. */
const CONTAINER_MCP_HUB_BUNDLE = '/usr/local/lib/atlas/mcp-hub-server.mjs';

/** Hard cap on the liveness probe exec — it's a trivial `kill -0` loop, so anything slower is a wedged
 *  docker exec we'd rather abandon (→ `unknown`) than let pile up behind the ~5s status poll. */
const PROBE_TIMEOUT_MS = 4_000;

/** Hard cap on an EPHEMERAL secret delivery exec (`writeToJobContainerPath`). The value target is usually a
 *  FIFO whose open blocks until the brain's waiting process reads it; if that process is dead the write hangs
 *  forever, so we abandon it and let the caller restart the login rather than wedge the request. */
const DELIVER_TIMEOUT_MS = 15_000;

/** Hard cap on the repo's cold-boot setup script exec. Generous (installs / index builds are legitimately
 *  slow) but bounded so a hung script can't wedge every cold attach — a timeout is reported as a failure the
 *  brain is woken to fix, not a stuck provision. */
const SETUP_SCRIPT_TIMEOUT_MS = 300_000;

/** How much of the setup script's combined stdout+stderr to keep as the failure `tail` surfaced to the brain. */
const SETUP_SCRIPT_TAIL_BYTES = 2_000;

/** Grace window during which a just-created `-net`/`-dind` is protected from {@link SandboxManager.reapOrphanedArtifacts}.
 *  `attach()` creates the network BEFORE the container that references it (the container-create is preceded by
 *  slow bind/mount setup), so for that window the network exists with no container and would otherwise look
 *  orphaned. `attach()` stamps the stem in `creating` at network-create time; the sweep skips any stem stamped
 *  within this window. Generous — the ensureNetwork→createContainer span is seconds — so a genuinely leaked
 *  network from a crashed create is still reclaimed on a later sweep once its stamp ages out. */
const CREATE_GRACE_MS = 5 * 60 * 1000;

/** realpath a path, falling back to the input if it can't be resolved (e.g. doesn't exist yet). */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Generate a container-local replacement for a `.git` pointer FILE (a linked worktree's or a submodule
 * checkout's). The real file reads `gitdir: <hostpath>` — pointing under the repo's shared common dir on
 * the HOST, which isn't mounted at that path in the box. This writes the SAME pointer rebased onto
 * {@link CONTAINER_GIT_COMMON} to `outFile` so in-container git resolves the gitdir → objects/refs,
 * without leaking host paths or mutating the host's real `.git` (the host still uses it). Returns the host
 * path of the generated file (to bind-mount over the pointer), or undefined if the pointer can't be
 * read/parsed or its gitdir isn't under `commonDir`.
 */
export function rebaseDotGit(gitPointerPath: string, commonDir: string, outFile: string): string | undefined {
  try {
    const raw = readFileSync(gitPointerPath, 'utf8').trim();
    const m = raw.match(/^gitdir:\s*(.+)$/);
    if (!m) return undefined;
    // The stored gitdir is usually absolute, but a submodule's `.git` may store it RELATIVE to the
    // pointer's own directory — resolve against that before diffing.
    const gitdir = m[1].trim();
    const abs = isAbsolute(gitdir) ? gitdir : resolve(dirname(gitPointerPath), gitdir);
    // Realpath-normalize BOTH operands before diffing. `git --git-common-dir` returns a realpath'd
    // absolute path, but the pointer's stored gitdir may use a symlinked form (on macOS the OS tmp/repos
    // root is `/var/folders/…` → `/private/var/folders/…`). Without normalizing, `relative()` yields a
    // bogus `../../…` and we'd bail, leaving no in-container `.git` → "not a git repository".
    const rel = relative(realpathSafe(commonDir), realpathSafe(abs)); // e.g. "worktrees/thread-X"
    if (!rel || rel.startsWith('..')) return undefined; // gitdir not under the common dir — bail safely
    writeFileSync(outFile, `gitdir: ${CONTAINER_GIT_COMMON}/${rel}\n`);
    return outFile;
  } catch {
    return undefined;
  }
}

/**
 * Worktree-relative paths of every submodule checkout (recursive), parsed from `.gitmodules` `path =`
 * entries. Used to shadow each submodule's `.git` pointer for the neutral container mount. Bounded by
 * actual submodule nesting; returns [] for the common no-submodule repo (no `.gitmodules`).
 */
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

/**
 * Container-provisioning revision — bump when the container's CREATE config changes in a way that an
 * existing container must be recreated to pick up (new mounts, volumes, labels, privileges…). Combined
 * with the image id into the `atlas.cfg` fingerprint so a stale container is auto-recreated on its next
 * attach (the thread/worktree survive — only the disposable container is replaced). Engine-CODE changes
 * do NOT bump this: the engine bundle is bind-mounted live, so they're served on the next turn with no
 * recreate. (rev 2 = added the live engine-bundle mount. rev 3 = worktree mounted at /workspace + git common
 * dir at /repo.git, was same-path host paths. rev 4 = added the durable per-thread /context shared mount.
 * rev 6 = added per-repo worktree cache mounts from `.atlas/worktree.json`, folded into the fingerprint.
 * rev 7 = added the system-wide shared pnpm store bind at /workspace/.pnpm-store.
 * rev 8 = fnm/python base image + per-repo Node: a repo's .nvmrc/.node-version is resolved at runtime and
 *   downloaded-on-demand into a SHARED cross-thread fnm store bound at /atlas-fnm (no versions baked).
 *   NB: image rebuilds are automatic now — `ensureImage` hashes the static build context and rebuilds on
 *   any Dockerfile/script change, so a rev bump never races a stale image.)
 * rev 9 = added the durable per-job /playground scratch mount (bound at /playground, keyed by jobId).
 * rev 10 = added the durable per-repo /home/atlas HOME mount (CONTAINER_HOME) + external (absolute)
 *   worktree-config mounts.
 * rev 11 = moved the shared pnpm store + fnm store + git-common dir under /.atlas (from /workspace/.pnpm-
 *   store, /atlas-fnm, /repo.git) and pinned pnpm's store-dir explicitly (Dockerfile — two mechanisms,
 *   since it moved between pnpm majors: `npm_config_store_dir` for 10.x, a global `XDG_CONFIG_HOME`-redirected
 *   config.yaml for 11.x) instead of relying on pnpm's per-disk fallback, which is what previously put a
 *   live store in the worktree.
 * rev 12 = shadow the `.git` pointer of every SUBMODULE checkout too (not just the superproject's), each
 *   rebased onto CONTAINER_GIT_COMMON — so in-container git (`status`/`add -A`/…, which recurse submodules
 *   by default) resolves a submodule-bearing repo instead of erroring `not a git repository: <hostpath>`.
 * rev 14 = force-recreate sandboxes created during the MCP-hub-bind outage so they pick up the corrected
 *   MCP_HUB_BUNDLE_PATH bind. The hub bundle bind (rev 13) fell back to an in-container path that isn't
 *   host-resolvable, leaving `Created` containers pinned to a bad bind; the bundle path isn't part of the
 *   `atlas.cfg` fingerprint, so a config-only fix wouldn't otherwise invalidate the stale containers.
 * rev 15 = per-repo cold-boot setup script (`repos.setup_script`): run on every COLD attach and its hash
 *   folded into the `atlas.cfg` fingerprint (so editing the script recreates a warm container to re-run it).
 *   Bumped once so existing warm containers recreate and pick up the run-on-cold codepath.
 *
 * NOTE: the per-repo mount SET + the setup-script hash are ALSO folded into the `atlas.cfg` fingerprint
 * below, so a changed manifest mount list / setup script recreates the container even without bumping this rev.
 */
const CONFIG_REV = 15;

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
 * `teardown` reclaims them. Labels are the source of truth for adoption (no new table).
 *
 * Inner dockerd (DinD) comes from `--privileged` + a per-sandbox /var/lib/docker volume (proven in D0);
 * `attach` waits for it to report ready before returning so the first build turn can use it.
 */

/**
 * De-dupe Docker bind strings (`host:target[:opts]`) by their CONTAINER TARGET (the 2nd `:`-segment;
 * both host + target are absolute so this is unambiguous). LAST occurrence wins — the caller appends
 * SYSTEM binds after manifest-derived cache mounts, so last-wins gives the system authority over any
 * stray worktree mount that collides. Docker hard-fails a create on a duplicate target ("Duplicate mount
 * point"), so this is the last-line guard that keeps a bad mount from wedging every turn on a thread.
 * Returns the deduped list (order = first appearance) + the dropped targets (for a warning). Pure.
 */
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

  /**
   * Container-name stems whose per-sandbox `-net`/`-dind` are mid-creation, keyed to the wall-clock ms when
   * `attach()` first created the network. Read by {@link reapOrphanedArtifacts} to skip in-flight artifacts
   * (see {@link CREATE_GRACE_MS}). Self-cleaning: entries are re-stamped on each attach attempt and pruned once
   * stale, so it never needs an explicit delete on the many early-return / throw paths of `attach()`.
   */
  private readonly creating = new Map<string, number>();

  constructor(
    @Inject(CONTAINER_ENGINE) private readonly engine: ContainerEngine,
    private readonly images: SandboxImageBuilder,
    private readonly env: EnvService,
    // @Optional so the direct-construction unit tests (`new SandboxManager(engine, images, env)`) still
    // compile + run; resolved from the @Global CaddyModule in the app.
    @Optional() private readonly caddy?: CaddyAdminClient,
  ) {}

  async attach(input: SandboxAttachInput): Promise<FeatureSandbox> {
    const { sandbox, orgId, jobId } = input;
    const name = this.containerName(orgId, sandbox.repoId, sandbox.branch, jobId);

    const image = await this.images.ensureImage(
      input.onMilestone ? () => input.onMilestone!('image_build') : undefined,
    );
    // Fold the per-repo mount SET into the fingerprint so a changed `.atlas/worktree.json` mount list
    // recreates an existing (warm) container — binds are only applied at create time.
    const mountKey = (input.mounts ?? []).map((m) => `${m.path}:${m.mode}`).sort().join(',');
    const mountFp = mountKey ? createHash('sha256').update(mountKey).digest('hex').slice(0, 12) : 'none';
    // Fold the cold-boot setup script into the fingerprint too: it runs only on a COLD attach, so an edited
    // script must recreate a warm container to re-run it (mirrors the mount-set rationale above).
    const scriptFp = input.setupScript
      ? createHash('sha256').update(input.setupScript).digest('hex').slice(0, 12)
      : 'none';
    const fingerprint = `${(await this.engine.imageId(image)) ?? 'noimg'}|cfg${CONFIG_REV}|m${mountFp}|s${scriptFp}`;

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
          await this.attachRedisBus(existing.id); // idempotent — re-ensure the redis bus after a restart
          await this.waitReady(existing.id);
        } else {
          this.logger.log(`reusing running sandbox ${name}`);
        }
        // COLD restart re-runs the repo's setup script (its container state is gone); a WARM reuse never does.
        return this.applySetupScript(this.augment(sandbox, existing.id, warm), existing.id, warm ? null : input.setupScript);
      }
    }

    // Guard the create window: the `-net` (and `-dind`) exist from here until `createContainer` below wires
    // them to a live container. Stamp the stem NOW so a concurrent `reapOrphanedArtifacts` sweep (timer or
    // promotion) doesn't see a network with no container yet and reap it out from under this attach. The
    // stamp ages out on its own — no cleanup needed on the throw / early-return paths.
    this.creating.set(name, Date.now());

    const network = `${name}-net`;
    await this.engine.ensureNetwork(network);

    const hostHome = join(this.agentHomeRootHost(), 'sandboxes', name);
    mkdirSync(hostHome, { recursive: true });
    // `/.atlas` (hostHome, PER-JOB) hosts three NESTED binds below whose actual host source is GLOBAL
    // (pnpm-store, fnm) or PER-REPO (git-common) — a nested bind target must already exist as a dir under
    // its parent's host source at container-create time (same requirement the /context/generated nested
    // bind already relies on), so pre-create empty mountpoints here; the nested binds shadow them.
    for (const child of ['pnpm-store', 'fnm', 'git-common']) {
      mkdirSync(join(hostHome, child), { recursive: true });
    }

    // The worktree mounts at a NEUTRAL container path (`/workspace`), not its host path — so the engine never
    // sees host-shaped paths. `cwd` is rewritten host→`/workspace` by the runner.
    const binds = [`${sandbox.worktreePath}:${CONTAINER_WORKTREE}`, `${hostHome}:${CONTAINER_AGENT_HOME}`];
    const gitDir = await this.gitCommonDir(sandbox.worktreePath);
    // Realpath-normalize BOTH operands before deciding linked-vs-clone. `git --git-common-dir` returns a
    // realpath'd absolute path, but `sandbox.worktreePath` may be a symlinked form (on macOS the OS tmp/repos
    // root is `/var/folders/…` → `/private/var/folders/…`). Without normalizing, a FULL CLONE — whose `.git`
    // IS inside the worktree — is misread as a linked worktree and gets a spurious `/.atlas/git-common`
    // overlay. Mirrors the same normalization `rebaseDotGit` already does before its `relative()` diff.
    const gitDirInsideWorktree =
      !!gitDir && realpathSafe(gitDir).startsWith(`${realpathSafe(sandbox.worktreePath)}/`);
    if (gitDir && !gitDirInsideWorktree) {
      // Linked worktree: its `.git` lives OUTSIDE the worktree (the repo's shared common dir). Mount the
      // common dir at a neutral path too, then SHADOW the worktree's `.git` pointer file — which holds an
      // absolute HOST path — with a container-local one so in-container git resolves the worktree's gitdir
      // → objects/refs, without leaking host paths or mutating the host's real `.git` (the host still uses
      // it). `commondir` is already relative (`../..`), so it resolves to CONTAINER_GIT_COMMON unchanged.
      binds.push(`${gitDir}:${CONTAINER_GIT_COMMON}`);
      const dotGit = rebaseDotGit(join(sandbox.worktreePath, '.git'), gitDir, join(hostHome, 'worktree.git'));
      if (dotGit) binds.push(`${dotGit}:${CONTAINER_WORKTREE}/.git`);

      // Same rebase for every SUBMODULE checkout's `.git` pointer. Each holds a gitdir under the SAME
      // common dir (`<common>/worktrees/<wt>/modules/…` for a linked worktree, or `<common>/modules/…`),
      // an absolute HOST path that isn't mounted at that path in the box. Without this, in-container git
      // recursing into submodules (the default for `status`/`add -A`) fails with `not a git repository`,
      // which is what made a submodule-bearing repo (e.g. cubix-infra) report a spurious "git issue".
      for (const sub of submoduleGitlinks(sandbox.worktreePath)) {
        const ptr = join(sandbox.worktreePath, sub, '.git');
        // Only a gitlink FILE needs rebasing; an uninitialized (missing) or embedded-repo (dir) `.git`
        // has no host-path pointer to rewrite.
        if (!existsSync(ptr) || !statSync(ptr).isFile()) continue;
        const out = join(hostHome, `submodule-${sub.replace(/\//g, '__')}.git`);
        const rebased = rebaseDotGit(ptr, gitDir, out);
        if (rebased) binds.push(`${rebased}:${CONTAINER_WORKTREE}/${sub}/.git`);
      }
    }
    // HOT-RELOAD: bind-mount the host engine bundle (read-only) over the baked-in one, so an engine
    // update (the API rebundles on boot) is picked up by the next `docker exec` in this container —
    // no recreate, no image rebuild. Falls back to the baked engine if the host bundle is absent.
    const bundle = engineBundlePath();
    if (existsSync(bundle)) {
      binds.push(`${bundle}:${CONTAINER_ENGINE_BUNDLE}:ro`);
    }
    const mcpBridge = mcpBridgeBundlePath();
    if (existsSync(mcpBridge)) {
      binds.push(`${mcpBridge}:${CONTAINER_MCP_BRIDGE_BUNDLE}:ro`);
    }
    // The persistent MCP hub bundle (launched by sandbox-init.sh), bind-mounted live like the engine bundle.
    const mcpHub = mcpHubBundlePath();
    if (existsSync(mcpHub)) {
      binds.push(`${mcpHub}:${CONTAINER_MCP_HUB_BUNDLE}:ro`);
    }
    // The host-maintained, READ-ONLY cross-repo reference library (per-tenant) at /refs.
    const refsDir = this.teamRefsDir(orgId);
    if (refsDir) {
      mkdirSync(refsDir, { recursive: true });
      binds.push(`${refsDir}:/refs:ro`);
    }
    // The central skills store — THIS org's whole subtree, read-write (see CONTAINER_SKILLS_STORE doc).
    // Unlike /refs (opt-in via REFS_ROOT), this always binds — skills work with no extra config in dev.
    const skillsDir = this.orgSkillsDir(orgId);
    mkdirSync(skillsDir, { recursive: true });
    binds.push(`${skillsDir}:${CONTAINER_SKILLS_STORE}`);
    // Atlas's own MANAGED (system-tier) skills — ONE fixed host dir (not per-org, code-defined; see
    // CONTAINER_SKILLS_MANAGED + skills/system-skill-registry.ts), read-only. Committed to the repo, so it
    // should always exist — the existsSync guard is a best-effort fallback like the bundle hot-reload binds
    // above, not an expected-missing case.
    const managedSkillsDir = managedSkillsRootHost();
    if (existsSync(managedSkillsDir)) {
      binds.push(`${managedSkillsDir}:${CONTAINER_SKILLS_MANAGED}:ro`);
    }
    // Atlas's GIT-SOURCED managed skills — ONE fixed host dir (not per-org; see CONTAINER_SKILLS_MANAGED_GIT
    // + skills/skill-store-paths.ts's managedGitSkillsRootHost), read-only. `ManagedSkillSyncService`
    // vendors it lazily (leader-gated, boot + periodic), so — unlike the committed managedSkillsDir above —
    // it's entirely normal for this to not exist yet (fresh checkout, sync hasn't run, or the leader is
    // still syncing); mkdir it eagerly so the bind never fails on that.
    const managedGitSkillsDir = managedGitSkillsRootHost(this.env.get('SKILLS_ROOT'));
    mkdirSync(managedGitSkillsDir, { recursive: true });
    binds.push(`${managedGitSkillsDir}:${CONTAINER_SKILLS_MANAGED_GIT}:ro`);
    // The thread's durable SHARED CONTEXT folder at /context — lives OUTSIDE the worktree (keyed by
    // jobId so it survives container recreate; the host reads it via contextDirHost()). THREE buckets,
    // pre-created so all always list cleanly:
    //   • specs/     — hand-authored by the brain (plan.md, diagrams). Read/write.
    //   • generated/ — SYSTEM-owned (decision-record.md, …), written ONLY by host tool calls. Mounted
    //                  READ-ONLY here (a nested :ro bind over the rw /context parent — Docker honors the
    //                  more-specific child mount) so no in-sandbox agent can edit a generated file.
    //   • artifacts/ — outputs for the human.
    const contextDir = this.contextDirHost(orgId, jobId, name);
    mkdirSync(join(contextDir, 'specs'), { recursive: true });
    mkdirSync(join(contextDir, 'generated'), { recursive: true });
    mkdirSync(join(contextDir, 'artifacts'), { recursive: true });
    binds.push(`${contextDir}:${CONTAINER_CONTEXT}`);
    binds.push(`${join(contextDir, 'generated')}:${CONTAINER_CONTEXT}/generated:ro`);

    // The job's durable PLAYGROUND scratch mount at /playground — a freeform read-write area OUTSIDE the
    // worktree (keyed by jobId like /context, so it survives container recreate and never lands in the
    // repo diff). Atlas writes throwaway spikes/scripts/ad-hoc installs here instead of into /workspace.
    // ensureHostOwnedDir (not plain mkdir) so in-container writes as the host uid stay host-owned.
    const playgroundDir = this.playgroundDirHost(orgId, jobId, name);
    this.ensureHostOwnedDir(playgroundDir);
    binds.push(`${playgroundDir}:${CONTAINER_PLAYGROUND}`);

    // The agent shell's durable HOME at /home/atlas (ENV HOME in the image). PER-REPO (one host dir shared
    // by every job on the repo, like the shared-rw cred cache — install-once/login-once is inherited), NEVER
    // global: a repo can populate its OWN home/bin but never another repo's, so a durable-dir binary can't
    // become a cross-repo attack. Combined with PATH being APPENDED in the Dockerfile (not prepended), an
    // installed binary can only ADD tools, never shadow a system one. Host-owned so the exec uid can write.
    const safeOrg = orgId.replace(/[^a-z0-9_-]/gi, '_') || 'org';
    const slug = sandbox.repoId.replace(/[^a-z0-9_-]/gi, '_') || 'repo';
    const homeDir = join(this.agentHomeRootHost(), 'caches', safeOrg, slug, '_home');
    this.ensureHostOwnedDir(homeDir);
    binds.push(`${homeDir}:${CONTAINER_HOME}`);

    // Per-repo CACHE MOUNTS from `.atlas/worktree.json` (resolved + validated by the WorktreeProvisioner).
    // Each lands at /workspace/<path>; per-thread gets its own host dir (no cross-thread write contention),
    // shared-ro mounts one immutable host dir read-only. Host dirs + the in-worktree mountpoint are
    // pre-created (+chowned to the host uid) so docker doesn't create them root-owned.
    binds.push(...this.cacheMountBinds(input));

    // SYSTEM-WIDE shared pnpm STORE — ONE host dir for every org/repo/thread (not keyed), bound UNDER
    // /.atlas (a nested bind — see the mountpoint pre-creation above) at the path the Dockerfile pins
    // pnpm's `storeDir` to explicitly, regardless of which pnpm version a repo's own `packageManager`
    // field (or corepack's own resolution) ends up running — see CONTAINER_PNPM_STORE. A dependency is
    // fetched ONCE globally and copied from the store by every later install (cross-device → copy, not
    // hardlink). Living outside
    // `/workspace` means it can never land in the worktree at all — which is why the host-managed
    // `.pnpm-store/` git-exclude could be removed with the writer-owns-commits change (writers own their
    // own `.gitignore` now); the pinned store is the load-bearing fix.
    const pnpmStore = join(this.agentHomeRootHost(), 'pnpm-store');
    this.ensureHostOwnedDir(pnpmStore);
    binds.push(`${pnpmStore}:${CONTAINER_PNPM_STORE}`);

    // SHARED cross-thread fnm version store (FNM_DIR in the image) — ONE host dir for every org/repo/thread
    // (not keyed), bound UNDER /.atlas (nested, like the pnpm store above). A Node version a repo pins via
    // .nvmrc/.node-version is downloaded ONCE globally (shell-init.sh runs `fnm use --install-if-missing`;
    // sandboxes have outbound egress) and reused by every later thread. Host dir pre-created + chowned to
    // the host uid so docker doesn't make it root-owned (turns exec as the host uid).
    const fnmStore = join(this.agentHomeRootHost(), 'fnm-store');
    this.ensureHostOwnedDir(fnmStore);
    binds.push(`${fnmStore}:${CONTAINER_FNM_STORE}`);

    // Reached ONLY when there was no existing container, or a stale one was just torn down above — never
    // on the warm-reuse / restart-a-stopped-container paths (both return earlier). The genuinely slow
    // "build the container from scratch" case.
    input.onMilestone?.('container_create');
    this.logger.log(`creating sandbox ${name} (image ${image}, net ${network})`);
    const id = await this.engine.createContainer({
      name,
      image,
      network,
      privileged: true,
      binds: this.dedupeBindsByTarget(binds),
      volumes: [{ name: `${name}-dind`, path: '/var/lib/docker' }],
      // Bake the preview identity so `atlas-svc` can advertise a service's public URL from inside the
      // box. Non-secret (a public host token + domain), so baking at create is fine. Only when exposure
      // is enabled AND this is a thread sandbox.
      ...(this.previewEnabled() && jobId
        ? {
            env: {
              ATLAS_PREVIEW_ID: previewId(jobId, this.previewSecret()),
              ATLAS_PREVIEW_DOMAIN: this.env.get('PREVIEW_BASE_DOMAIN')!,
            },
          }
        : {}),
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
    // Freshly created → cold: run the repo's setup script (if any) before handing the sandbox back.
    return this.applySetupScript(this.augment(sandbox, id, false), id, input.setupScript);
  }

  /**
   * Attach a started sandbox to the internal Redis bus (`SANDBOX_BUS_NETWORK`) so the in-container engine
   * can reach Redis — its only transport (ADR 0001). The bus is `internal: true`, so the sandbox reaches
   * ONLY Redis off it, never the host or internet. Unset in dev (the sandbox reaches Redis via
   * `host.docker.internal`), so this is a no-op there; set to `atlas-bus` in prod compose. Idempotent.
   */
  private async attachRedisBus(containerId: string): Promise<void> {
    const bus = this.env.get('SANDBOX_BUS_NETWORK');
    if (!bus) return;
    await this.engine.ensureNetwork(bus);
    await this.engine.connectNetwork(containerId, bus);
  }

  /** Whether a sandbox's repo is the Atlas repo itself, per the configured `ATLAS_REPO_SLUG`. Not
   *  hardcoded — the prod slug is set in compose; unset (dev) means no repo is ever treated as Atlas. */
  private isAtlasRepo(repoId: string): boolean {
    return isAtlasRepo(repoId, this.env);
  }

  /** The deterministic container name of a thread's sandbox — the preview reverse-proxy upstream host. */
  sandboxContainerName(jobId: string): string {
    return this.containerName('', '', '', jobId);
  }

  /** Bridge the Caddy container into a thread sandbox's `-net` so the proxy can reach the dev-server by
   *  name. Idempotent (connectNetwork ignores "already exists"); no-op when exposure is disabled. */
  async bridgeCaddyToSandbox(jobId: string): Promise<void> {
    if (!this.previewEnabled()) return;
    await this.engine.connectNetwork(this.caddyContainer(), `${this.containerName('', '', '', jobId)}-net`);
  }

  /** Disconnect the Caddy container from a thread sandbox's `-net`. Idempotent; no-op when disabled. */
  async unbridgeCaddyFromSandbox(jobId: string): Promise<void> {
    if (!this.previewEnabled()) return;
    await this.engine.disconnectNetwork(this.caddyContainer(), `${this.containerName('', '', '', jobId)}-net`);
  }

  /** JobIds of every currently-running managed THREAD sandbox (mirrors the {@link containerName} scheme). */
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
      // The network + DinD volume share the container name stem; drop them so they don't accumulate.
      await this.cleanupArtifacts(info.name);
      this.logger.log(`tore down sandbox ${info.name}`);
    }
  }

  /**
   * Reclaim a thread's container by its DETERMINISTIC NAME — the terminal-cleanup counterpart to
   * {@link attach}, which resolves the SAME name (`atlas-sbx-thread-<id>`) regardless of
   * whether a `container_id` is currently known. This matters because `JobLifecycleService.reconcileOnBoot`
   * nulls a row's `container_id` on every restart while the real container keeps running; a close/delete
   * that happened before the thread's next turn would skip the id-gated {@link teardown} and LEAK the
   * container (and its `-net`/`-dind`) forever. If the container is already gone, its network/volume are
   * still reclaimed by name (cheap + idempotent). Never throws on a missing artifact.
   */
  async teardownByIdentity(input: SandboxAttachInput): Promise<void> {
    const { sandbox, orgId, jobId } = input;
    const name = this.containerName(orgId, sandbox.repoId, sandbox.branch, jobId);
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

  /**
   * Reclaim FULLY ORPHANED sandbox artifacts — `atlas-sbx-*-net` networks and `atlas-sbx-*-dind`
   * volumes whose owning container no longer exists. {@link teardown} handles the
   * normal path; this is the catch-all for leaks from crashes, `kill -9`, or pre-fix runs (where
   * teardown dropped the container but not its network/volume). Each artifact's name stem is checked
   * against live container names, so one still attached to a container is never touched. Best-effort —
   * an unremovable artifact is logged and skipped. Returns how many of each were reclaimed.
   */
  async reapOrphanedArtifacts(): Promise<{ networks: number; volumes: number }> {
    const live = new Set((await this.engine.list({ all: true })).map((c) => c.name));
    // Prune stale create-stamps, then treat any still-fresh stem as protected: its container is mid-create
    // (network exists, container not yet), so it must NOT be reaped despite having no live container.
    const now = Date.now();
    for (const [stem, at] of this.creating) {
      if (now - at >= CREATE_GRACE_MS) this.creating.delete(stem);
    }
    const isCreating = (stem: string): boolean => now - (this.creating.get(stem) ?? 0) < CREATE_GRACE_MS;
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

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────

  private augment(sandbox: FeatureSandbox, containerId: string, warm: boolean): FeatureSandbox {
    const user = hostExecUser();
    return { ...sandbox, containerId, warm, ...(user ? { execUser: user } : {}) };
  }

  /**
   * Attach the cold-boot setup-script result to a just-attached sandbox — a no-op (returns `fs` unchanged)
   * when there's no script or it's a warm reuse (caller passes `script=null` then). Kept OUT of {@link augment}
   * so that stays a pure, synchronous shape-builder (also used for teardown).
   */
  private async applySetupScript(
    fs: FeatureSandbox,
    containerId: string,
    script: string | null | undefined,
  ): Promise<FeatureSandbox> {
    if (!script) return fs;
    return { ...fs, setupScriptResult: await this.runSetupScript(containerId, script) };
  }

  /**
   * Run the repo's cold-boot setup script inside a freshly-attached (COLD) container, via the SAME non-login
   * `bash -c` path the agent's own Bash tool uses so the image's `BASH_ENV` (`/etc/atlas/shell-init.sh` →
   * fnm/direnv/node) is applied. Execs as the host uid so anything it writes to the bind-mounted worktree stays
   * host-owned. NEVER throws — a non-zero exit, an exec error, or a timeout all resolve to `{ ok:false }` with
   * the tail of the output, which the caller stamps on the sandbox row + wakes the brain to fix.
   */
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
      this.logger[ok ? 'log' : 'warn'](`setup script on ${containerId.slice(0, 12)} exited ${res.exitCode}`);
      return { ok, exitCode: res.exitCode, tail: out.trim() };
    } catch (err) {
      const aborted = ctrl.signal.aborted;
      this.logger.warn(
        `setup script on ${containerId.slice(0, 12)} failed: ${aborted ? 'timeout' : String(err)}`,
      );
      const tail = (
        aborted ? `setup script timed out after ${SETUP_SCRIPT_TIMEOUT_MS}ms\n${out}` : `setup script exec error: ${String(err)}\n${out}`
      ).trim();
      return { ok: false, exitCode: -1, tail: tail.slice(-SETUP_SCRIPT_TAIL_BYTES) };
    } finally {
      clearTimeout(timer);
    }
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
    await this.removeSandboxNet(net).catch((err) => {
      this.logger.debug(`could not remove network ${net}: ${err}`);
    });
    await this.engine.removeVolume(vol).catch((err) => {
      this.logger.debug(`could not remove volume ${vol}: ${err}`);
    });
  }

  /**
   * Remove a sandbox's `-net`, first tearing down any preview attachments that reference it: when the net
   * belongs to a THREAD sandbox and exposure is on, drop the job's Caddy routes and unbridge Caddy from
   * the net FIRST (Docker refuses to remove a network with active endpoints). All preview steps are
   * best-effort so a never-exposed / feature-off sandbox tears down exactly as before. The caller owns the
   * final removeNetwork's error semantics.
   */
  private async removeSandboxNet(netName: string): Promise<void> {
    const m = netName.match(/^atlas-sbx-thread-(.+)-net$/);
    if (m && this.caddy && this.previewEnabled()) {
      const jobId = m[1];
      await this.caddy.deleteRoutesByPrefix(routePrefix(jobId, this.previewSecret())).catch(() => undefined);
      await this.engine.disconnectNetwork(this.caddyContainer(), netName).catch(() => undefined);
    }
    await this.engine.removeNetwork(netName);
  }

  /** True when sandbox-preview exposure is configured (a base domain is set). */
  private previewEnabled(): boolean {
    return !!this.env.get('PREVIEW_BASE_DOMAIN');
  }

  /** The Caddy container to bridge into sandbox nets (default `atlas-caddy`). */
  private caddyContainer(): string {
    return this.env.get('CADDY_CONTAINER_NAME') ?? 'atlas-caddy';
  }

  /** The HMAC key for preview tokens — falls back to the at-rest secrets key so dev works without extra config. */
  private previewSecret(): string {
    return this.env.get('PREVIEW_ID_SECRET') ?? this.env.get('SECRETS_ENCRYPTION_KEY');
  }

  private agentHomeRootHost(): string {
    return atlasAgentHomeBase(this.env.get('AGENT_HOME_ROOT'));
  }

  /**
   * The HOST path of a thread BRAIN session's Claude transcript root — `<brainHome>/claude/projects`, under
   * which the SDK writes `<cwd-slug>/<sessionId>.jsonl` (one file per session). This dir survives container
   * reaping (it is the host side of the {@link CONTAINER_AGENT_HOME} bind), so the backend can read a
   * completed-but-unpersisted turn after a restart (crash recovery).
   *
   * Located by jobId alone: the container dir is `atlas-sbx-thread-<jobId>`, so we GLOB the sandbox
   * dir whose `-thread-<…>` suffix is a prefix of `jobId` (tolerates the 40-char `part()` cap truncating
   * the tail), then walk the nested `<orgId>/<repoId>/<jobId>/brain` engine-home leaf under it (see
   * {@link findJobHomeDir} — a per-job sandbox only ever holds ITS OWN job's org/repo). Null when nothing
   * is on disk yet.
   */
  brainTranscriptProjectsDir(jobId: string): string | null {
    const sandboxHome = this.findSandboxHomeDir(jobId);
    if (!sandboxHome) return null;
    const jobHome = this.findJobHomeDir(sandboxHome, jobId);
    if (!jobHome) return null;
    const brainHome = join(jobHome, 'brain');
    return existsSync(brainHome) ? join(brainHome, 'claude', 'projects') : null;
  }

  /**
   * Walk a sandbox home down to its `<orgId>/<repoId>/<jobId>` engine-home leaf (see {@link EngineHomeKey}).
   * A per-job sandbox home only EVER holds that one job's own org + repo subtree, so there is always exactly
   * one dir at each of the first two levels; anything else (not-yet-provisioned, or an unexpected shape) is
   * treated as absent rather than guessed at. Null when no engine home has been created here yet.
   */
  private findJobHomeDir(sandboxHome: string, jobId: string): string | null {
    const orgDir = this.soleSubdir(sandboxHome);
    if (!orgDir) return null;
    const repoDir = this.soleSubdir(join(sandboxHome, orgDir));
    if (!repoDir) return null;
    const jobHome = join(sandboxHome, orgDir, repoDir, jobId);
    return existsSync(jobHome) ? jobHome : null;
  }

  /** The single subdirectory of `dir`, or null when it's absent/empty/ambiguous (more than one entry). */
  private soleSubdir(dir: string): string | null {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    return entries.length === 1 ? entries[0]! : null;
  }

  /**
   * The HOST path of a thread's `atlas-svc` supervisor dir — `<sandboxHome>/supervisor`, the host side of
   * the {@link CONTAINER_AGENT_HOME} bind (`/.atlas/supervisor` in-container). Holds one `<id>.json`
   * marker + `<id>.log` per process the agent started via `atlas-svc run`. Durable across container
   * recreate (same bind as the brain transcript); null when the thread has no sandbox home on disk yet.
   */
  supervisorDirHost(jobId: string): string | null {
    const sandboxHome = this.findSandboxHomeDir(jobId);
    return sandboxHome ? join(sandboxHome, 'supervisor') : null;
  }

  /**
   * Probe the job's container for which supervised process-groups are alive. Resolves the container by
   * its deterministic name, and — if it's running — execs the same `kill -0 -$pgid` test `atlas-svc`
   * uses. Returns `down` when there is no running container (every marker is then a dead previous
   * generation), `up` with the current boot time + alive pgids otherwise, and `unknown` on any failure
   * so a transient error never masquerades as `stopped`/`running`.
   */
  async probeLiveness(jobId: string, pgids: number[]): Promise<ServiceLivenessProbe> {
    try {
      // Same name `attach` created it with — for a job the name depends only on jobId.
      const name = this.containerName('', '', '', jobId);
      const info = await this.engine.inspect(name);
      if (!info || info.state !== 'running' || !info.startedAt) return { status: 'down' };

      // Nothing to probe (all markers had null pgids) — still `up`, with an empty alive set, so the
      // caller can apply the generation gate to each marker.
      const valid = pgids.filter((g) => Number.isInteger(g) && g > 0);
      if (valid.length === 0) return { status: 'up', containerStartedAt: info.startedAt, alive: [] };

      // A process-group is alive iff `kill -0` on its negated pgid succeeds (mirrors atlas-svc's
      // is_alive). Echo the survivors; run as the uid that launched them so ownership matches (no EPERM
      // false-negatives). `dash`-safe: plain `for`, quoted expansion.
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
      this.logger.warn(`probeLiveness(${jobId.slice(0, 8)}) failed — reporting unknown: ${String(err)}`);
      return { status: 'unknown' };
    }
  }

  /**
   * Push the sandbox's user MCP servers to the persistent per-sandbox HUB (see `image/mcp-hub-server.ts`):
   * write the resolved UNION (secrets inlined) + the stdio `spawn` identity to the host side of the durable
   * `/.atlas` bind, then `SIGHUP` the hub so it reconciles (connect new / drop removed / leave unchanged).
   * The config is the single source of truth — writing it converges the hub even if the signal is missed
   * (the hub also mtime-re-stats). Called at provision (create / reset / warm re-attach) by
   * `WorktreeProvisioner`. Best-effort: writes even when the container isn't running yet (the hub reads it on
   * boot), signals only when it is; never throws.
   */
  async kickMcpHubRefresh(input: { jobId: string; servers: ResolvedMcpServer[] }): Promise<void> {
    try {
      const name = this.containerName('', '', '', input.jobId);
      const hostHome = join(this.agentHomeRootHost(), 'sandboxes', name);
      mkdirSync(hostHome, { recursive: true });

      // stdio children must run with the per-turn exec identity (host uid, /workspace, /home/atlas HOME) —
      // NOT the hub's root/PID1 one. PATH covers the image's node/npx + system bins (a repo's fnm/pnpm PATH
      // additions are shell-init only and don't apply to a hub-spawned server).
      const [uidStr, gidStr] = (hostExecUser() ?? '').split(':');
      const uid = Number.parseInt(uidStr ?? '', 10);
      const gid = Number.parseInt(gidStr ?? '', 10);
      const config: McpHubConfig = {
        spawn: {
          ...(Number.isInteger(uid) ? { uid } : {}),
          ...(Number.isInteger(gid) ? { gid } : {}),
          cwd: CONTAINER_WORKTREE,
          home: CONTAINER_HOME,
          baseEnv: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin', LANG: 'C.UTF-8' },
        },
        servers: input.servers,
      };
      // 0600: the config carries inlined upstream secrets. Same trust boundary as the durable agent home.
      // hostHome is the host side of the `/.atlas` bind, so the basename must match CONTAINER_MCP_HUB_CONFIG.
      writeFileSync(join(hostHome, basename(CONTAINER_MCP_HUB_CONFIG)), JSON.stringify(config), { mode: 0o600 });

      const info = await this.engine.inspect(name);
      if (!info || info.state !== 'running') return; // hub reads the file on its next boot
      await this.engine.execDetached(
        info.id,
        ['sh', '-c', `kill -HUP "$(cat "${CONTAINER_MCP_HUB_DIR}/hub.pid" 2>/dev/null)" 2>/dev/null || true`],
        { ...(hostExecUser() ? { user: hostExecUser() } : {}) },
      );
    } catch (err) {
      this.logger.debug(`kickMcpHubRefresh(${input.jobId.slice(0, 8)}) skipped: ${String(err)}`);
    }
  }

  /**
   * Write the current GitHub App installation token to the host side of the job's `/.atlas` bind (the file
   * the in-sandbox git `credential.helper` reads). Atomic (temp + rename) so a concurrent `cat` on the push
   * critical path never sees a half-written token. 0600: it is a live credential. See
   * {@link SandboxProvider.writeGithubTokenFile}.
   */
  async writeGithubTokenFile(jobId: string, token: string): Promise<void> {
    const name = this.containerName('', '', '', jobId);
    const hostHome = join(this.agentHomeRootHost(), 'sandboxes', name);
    mkdirSync(hostHome, { recursive: true });
    const dest = join(hostHome, basename(GITHUB_TOKEN_FILE));
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, token, { mode: 0o600 });
    renameSync(tmp, dest);
  }

  /**
   * EPHEMERAL secret delivery — pipe a value into a path inside a thread's LIVE container over exec STDIN
   * (never argv/env, so it can't surface in `docker inspect`/`ps`), bounded by `timeoutMs`. `cat > "$1"`
   * writes exactly the bytes we send to `path`; when `path` is a FIFO the brain wired a waiting process to
   * read (an OAuth-login prompt), the open blocks until that reader exists — so a DEAD reader trips the
   * timeout and we return `{ ok:false }` for the caller to restart the flow, rather than hanging the request.
   * Runs as the host exec-uid so a FIFO the brain created (also as that uid) is writable (no EPERM). See
   * {@link SandboxProvider.writeToJobContainerPath}.
   */
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
      // The AbortController fired (timeout) — the target had no live reader, or the write hung.
      return {
        ok: false,
        reason: 'delivery timed out — the target process is not reading',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Tear down ALL supervised services in a job's live container by running `atlas-svc stop-all` over
   * `docker exec`, as the agent's exec-uid so it can signal the process groups the agent started (the
   * supervisor state lives at the fixed in-container `/.atlas/supervisor`, so this reaches exactly those
   * services). Best-effort — a missing/stopped container or a non-zero exit is returned as `{ ok:false }`,
   * never thrown; the driver logs it and moves on. See {@link SandboxProvider.stopAllServices}.
   */
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

  /**
   * Locate a thread's sandbox home dir on the host — `<agentHomeRoot>/sandboxes/atlas-sbx-…-thread-<id>`.
   * GLOBS the sandboxes root for the `-thread-<…>` suffix that is a PREFIX of `jobId` (tolerates the
   * container-name `part()` cap truncating the tail). Null if nothing is on disk yet (no sandbox ever
   * provisioned for this thread).
   */
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

  /**
   * The HOST path of a thread's durable `/context` shared folder — the same dir bind-mounted into the
   * container at {@link CONTAINER_CONTEXT}. Keyed by `jobId` so it is STABLE across the container's
   * lifecycle (recreate, idle-reap, cold re-attach) and never deleted by container teardown (only by a
   * deep thread delete). The brain authors plan/thread specs here and reads them back via this path;
   * the build sessions read it as shared context. Sandboxes WITHOUT a thread (gate runs) fall back to a
   * name-keyed dir — never resolved by the brain, just keeps the mount uniform.
   */
  contextDirHost(orgId: string, jobId?: string, name?: string): string {
    const root = join(this.agentHomeRootHost(), 'contexts');
    if (jobId) return join(root, orgId, jobId);
    return join(root, '_sandbox', name ?? 'unkeyed');
  }

  /**
   * The HOST path of a job's durable `/playground` scratch folder — the same dir bind-mounted into the
   * container at {@link CONTAINER_PLAYGROUND}. Keyed by `jobId` (like {@link contextDirHost}) so it is
   * STABLE across the container's lifecycle and shared by every build lane of the job; never deleted by
   * container teardown (only by a deep job delete, which `JobLifecycleService.deleteJobDeep` reclaims).
   * Sandboxes WITHOUT a job (gate runs) fall back to a name-keyed dir — never resolved, just keeps the
   * mount uniform.
   */
  playgroundDirHost(orgId: string, jobId?: string, name?: string): string {
    const root = join(this.agentHomeRootHost(), 'playgrounds');
    if (jobId) return join(root, orgId, jobId);
    return join(root, '_sandbox', name ?? 'unkeyed');
  }

  /**
   * Build the bind strings for the per-repo cache mounts AND pre-create their host dirs + in-worktree
   * mountpoints (chowned to the host uid so docker doesn't create them root-owned). The bind target is
   * /workspace/<path>. Host dir by mode:
   *   - `per-thread` → its own dir keyed by thread (or branch, for the jobId-less gate path).
   *   - `shared-ro`  → one read-only dir per repo (`_shared`).
   *   - `shared-rw`  → one read-WRITE dir per repo (`_shared-rw`) — persistent auth STATE (e.g. `.gcloud`)
   *     reused by every job for the repo; set up once, survives sandbox reap. The concurrent-writer race
   *     is accepted (see sandbox/container-paths.ts and onboarding/workspace-config.store.ts).
   */
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
      const tier = m.mode === 'shared-ro' ? '_shared' : m.mode === 'shared-rw' ? '_shared-rw' : perThreadKey;
      const ro = m.mode === 'shared-ro' ? ':ro' : '';
      // EXTERNAL (absolute container path, e.g. /root/.config/gcloud): the target IS the path — bound
      // OUTSIDE /workspace, so nothing lands in the git tree (no gitignore needed). Docker auto-creates the
      // container mountpoint, so only the HOST dir is pre-created; it still lives under the managed org/repo
      // cache root (never an arbitrary host path). Defense-in-depth: skip a reserved target (the hydrator +
      // tool already reject these upstream).
      const external = isExternalMountPath(m.path);
      if (external && isReservedContainerPath(m.path)) continue;
      const hostDir = external
        ? join(cacheRoot, tier, '_ext', m.path.replace(/^\/+/, ''))
        : join(cacheRoot, tier, m.path);
      this.ensureHostOwnedDir(hostDir);
      // A `shared-rw` dir holds persistent AUTH state (a `.gcloud` login writes a refresh token there in
      // plaintext) reused by every job on the repo. Lock it to owner-only (0700) so the credential isn't
      // group/world-readable on the host. Best-effort — a chmod failure must not wedge the attach.
      if (m.mode === 'shared-rw') {
        try {
          chmodSync(hostDir, 0o700);
        } catch {
          /* best-effort: we created it owner-owned anyway */
        }
      }
      if (external) {
        binds.push(`${hostDir}:${m.path}${ro}`);
        continue;
      }
      // WORKTREE-relative: lands at /workspace/<path> (original behaviour). Manifest paths already use '/'.
      this.ensureHostOwnedDir(join(sandbox.worktreePath, m.path));
      binds.push(`${hostDir}:${CONTAINER_WORKTREE}/${m.path}${ro}`);
    }
    return binds;
  }

  /**
   * De-dupe bind strings by their CONTAINER TARGET before container creation — Docker hard-fails the
   * whole create on a duplicate target ("Duplicate mount point"), which would wedge every turn on the
   * thread. A bind is `host:target[:opts]`; the target is the 2nd `:`-segment (both host + target are
   * absolute). LAST occurrence wins: the system binds (shared pnpm/fnm store, context) are appended
   * AFTER the manifest-derived cache mounts in `createSandbox`, so last-wins gives the system authority
   * over any stray worktree mount that slipped through the manifest guards. Nested targets like
   * `/context` and `/context/generated` differ, so both survive. Belt-and-suspenders behind the
   * manifest/authoring reserved-path drops.
   */
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

  /** This org's whole skills-store subtree, mounted read-write at {@link CONTAINER_SKILLS_STORE}. Always
   *  resolves (SKILLS_ROOT ?? the local `.atlas-state/skills` default) — unlike `teamRefsDir`, never undefined. */
  private orgSkillsDir(orgId: string): string {
    return orgSkillsRootHost(this.env.get('SKILLS_ROOT'), orgId);
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

  /**
   * Thread sandboxes: `atlas-sbx-thread-<jobId>`. The thread uuid is the globally-unique PK, so it alone
   * IS the stable identity (1 thread = 1 container, across branch + re-attach) — org and repo add no
   * uniqueness and only bloated the name, so they're dropped. The `-thread-` token is kept (not just for
   * readability): crash recovery ({@link brainTranscriptProjectsDir}) uses it both to distinguish thread
   * sandboxes from the gate path and to extract the jobId, and the FULL uuid stays so its
   * `jobId.startsWith(suffix)` prefix-match holds.
   *
   * The acceptance gate (synthetic `orgId:'gate'`, no thread) has no `jobId`: `atlas-sbx-<org>-<repo>-
   * <branch>` (one container per branch). Branch names aren't globally unique, so org + repo + branch
   * together are what make those names unique.
   */
  private containerName(orgId: string, repoId: string, branch: string, jobId?: string): string {
    const part = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40);
    if (jobId) return `atlas-sbx-thread-${part(jobId)}`;
    return `atlas-sbx-${part(orgId)}-${part(repoId)}-${part(branch)}`.slice(0, 120);
  }
}
