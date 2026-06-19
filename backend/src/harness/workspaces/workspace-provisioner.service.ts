import { EnvService } from '@core/config/env/env.service';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CONTAINER_ENGINE,
  type ContainerEnginePort,
} from './container-engine.port';

/** Defaults mirror `build-daemon.sh` so the slack-app and the manual script agree on names. */
const DEFAULT_DAEMON_BUILD_VOLUME = 'agent-daemon-build';
const DEFAULT_PNPM_STORE_VOLUME = 'agent-pnpm-store';
/** The daemon-build's content-version stamp, as read INSIDE the throwaway version-reader container (the
 * build volume is mounted read-only at `/daemon` there). `daemon-build-inner.sh` writes `sha256(main.js)`
 * here; the boot reconciliation compares this CURRENT version against each running sandbox's self-reported
 * `version()`. Mirrors the in-sandbox path (`dirname(DAEMON_ENTRY)/.build-version`). */
const DAEMON_BUILD_VERSION_PATH = '/daemon/backend/dist/daemon/.build-version';
/** Paths relative to the repo root (the build context + the bind-mounted `/src`). */
const DOCKERFILE = 'backend/src/daemon/Dockerfile';
const ENTRYPOINT = 'backend/src/daemon/entrypoint.sh';
/** The build recipe, addressed inside the build container (`/src` = the repo root, mounted read-only). */
const INNER_SCRIPT = '/src/backend/scripts/daemon-build-inner.sh';

/**
 * Self-provisions the workspace sandbox runtime AT BOOT, so deploying is just running the slack-app —
 * no manual `pnpm daemon:build` (the SSH step this removes). It owns the same lifecycle the host script
 * did, through the existing `ContainerEnginePort` (no `docker` CLI / bash dependency):
 *
 *   1. build the generic base image if missing (or `REBUILD_IMAGE`),
 *   2. ensure the daemon-build + pnpm-store volumes,
 *   3. (re)build the daemon INTO the volume (incremental — frozen lockfile + persistent pnpm-store make
 *      `pnpm install` a near-no-op, so only `nest build` re-runs; `SKIP_DAEMON_BUILD` reuses as-is).
 *
 * The daemon stays MOUNTED (not baked), so a redeploy refreshes the volume and a sandbox picks up the
 * new code on its next (re)start.
 *
 * Correctness does NOT depend on hook ordering (Nest 11 fires a module's bootstrap hooks via
 * `Promise.all`, and `slack-app/main.ts` connects Socket Mode before `app.listen()` triggers them). The
 * work is driven from `ContainerManagerService.create()` awaiting {@link ensureProvisioned}, which is
 * MEMOIZED — the first caller runs it, the rest await the same promise. `onApplicationBootstrap` only
 * *warms* it early. A rejection clears the memo so a later `create()` retries (one transient Docker
 * error doesn't poison every future spawn). A Docker-absent host logs + skips, exactly like the
 * manager's reconcile hook.
 */
@Injectable()
export class WorkspaceProvisionerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkspaceProvisionerService.name);
  /** The memoized provision promise (the warm-up and every `create()` share this one run). */
  private inFlight?: Promise<void>;
  /** Memoized just-built daemon version (`sha256(main.js)` from the volume stamp). Read ONCE after the
   * volume is current — the build doesn't change under us within a process — and reused by the boot
   * version-reconciliation. `undefined` means not-yet-read OR a build that predates the stamp; the reader
   * distinguishes via the resolved promise (a `''`/absent stamp). */
  private buildVersion?: Promise<string | undefined>;

  constructor(
    @Inject(CONTAINER_ENGINE) private readonly engine: ContainerEnginePort,
    private readonly env: EnvService,
  ) {}

  onApplicationBootstrap(): void {
    // Warm the build early so the first sandbox isn't slowed — but never block boot, and a Docker-absent
    // host just logs + skips (the clear error only surfaces when a sandbox is actually requested).
    void this.ensureProvisioned().catch((err) =>
      this.logger.warn(
        `workspace provisioning (warm-up) skipped: ${err instanceof Error ? err.message : err}`,
      ),
    );
  }

  /** Idempotent + memoized: ensure the base image + daemon build are ready. Concurrent callers share one
   * run; on failure the memo is cleared so the next caller retries. */
  ensureProvisioned(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.provision().catch((err) => {
        this.inFlight = undefined;
        throw err;
      });
    }
    return this.inFlight;
  }

  /**
   * The CURRENT (just-built) daemon build version — the `sha256(main.js)` stamp `daemon-build-inner.sh`
   * wrote into the volume. Ensures the volume is provisioned FIRST (so the read reflects the freshly-built
   * daemon, not a stale stamp), then reads it once and caches the result. Drives the boot-time version
   * reconciliation: the host restarts any running sandbox whose `version()` ≠ this.
   *
   * Returns `undefined` when sandboxes are disabled (no `WORKSPACE_IMAGE`) or the stamp is absent (a build
   * that predates the stamp) — the reconciliation then SKIPS (it can't know the target, so it won't bounce
   * running sandboxes blindly). Read-once, but NOT cleaked into the provision memo, so it never blocks a
   * spawn; a transient read error rejects this call's promise without poisoning future ones.
   */
  currentBuildVersion(): Promise<string | undefined> {
    if (!this.buildVersion) {
      this.buildVersion = this.readBuildVersion().catch((err) => {
        this.buildVersion = undefined; // clear so a later caller can retry
        throw err;
      });
    }
    return this.buildVersion;
  }

  private async readBuildVersion(): Promise<string | undefined> {
    const image = this.env.get('WORKSPACE_IMAGE');
    if (!image) return undefined; // sandboxes disabled — nothing to reconcile against
    await this.ensureProvisioned(); // ensure the volume holds the freshly-built daemon before reading
    const buildVolume =
      this.env.get('WORKSPACE_DAEMON_BUILD_VOLUME') ??
      DEFAULT_DAEMON_BUILD_VOLUME;
    const version = await this.engine.readDaemonBuildVersion(
      buildVolume,
      image,
      DAEMON_BUILD_VERSION_PATH,
    );
    if (!version) {
      this.logger.warn(
        `daemon build has no .build-version stamp in ${buildVolume} — boot version reconciliation will ` +
          'be skipped (rebuild the daemon to stamp it). Running sandboxes are left as-is.',
      );
      return undefined;
    }
    this.logger.log(`current daemon build version: ${version}`);
    return version;
  }

  private async provision(): Promise<void> {
    const image = this.env.get('WORKSPACE_IMAGE');
    if (!image) {
      // No image configured ⇒ sandboxes are disabled (the manager throws its own clear error at create).
      this.logger.log(
        'WORKSPACE_IMAGE unset — skipping workspace image/daemon provisioning (sandboxes disabled).',
      );
      return;
    }
    const repoRoot = this.repoRoot();
    const buildVolume =
      this.env.get('WORKSPACE_DAEMON_BUILD_VOLUME') ??
      DEFAULT_DAEMON_BUILD_VOLUME;
    const storeVolume =
      this.env.get('WORKSPACE_PNPM_STORE_VOLUME') ?? DEFAULT_PNPM_STORE_VOLUME;

    // 1) Base image — build only if missing (or forced). The image carries just the toolchain, so it
    //    rarely changes; the daemon code lives in the mounted volume (step 3), not the image.
    const forceImage = this.env.get('REBUILD_IMAGE') === true;
    if (forceImage || !(await this.engine.imagePresent(image))) {
      this.logger.log(
        `building workspace base image ${image} (context ${repoRoot})…`,
      );
      await this.engine.buildImage({
        contextDir: repoRoot,
        src: [DOCKERFILE, ENTRYPOINT],
        dockerfile: DOCKERFILE,
        tag: image,
        ...(forceImage ? { pull: true } : {}),
      });
      this.logger.log(`workspace base image ${image} built.`);
    } else {
      this.logger.log(`workspace base image ${image} present — reusing.`);
    }

    // 2) Persistent volumes (idempotent — an existing name is kept).
    await this.engine.createVolume(buildVolume);
    await this.engine.createVolume(storeVolume);

    // 3) Daemon build into the volume. Always rebuilt once per process (cheap + always-correct, incl.
    //    uncommitted dev edits); `SKIP_DAEMON_BUILD` is the fast-restart escape hatch that reuses the
    //    existing volume (presence is still gated at create by `ensureBuildPresent`).
    if (this.env.get('SKIP_DAEMON_BUILD') === true) {
      this.logger.log(
        `SKIP_DAEMON_BUILD set — reusing existing daemon build in ${buildVolume} (no rebuild).`,
      );
      return;
    }
    this.logger.log(
      `building daemon into ${buildVolume} (store ${storeVolume})…`,
    );
    await this.engine.runBuildContainer({
      image,
      repoRoot,
      buildVolume,
      storeVolume,
      innerScript: INNER_SCRIPT,
    });
    this.logger.log(`daemon build ready in ${buildVolume}.`);
  }

  /** The host repo root the build context + the `/src` bind-mount resolve against (the dir that holds
   * `backend/src/daemon/Dockerfile`). `REPO_ROOT` wins (set it when the slack-app runs in a container
   * whose path differs from the host's); else walk up from this compiled file to the monorepo root
   * (the `pnpm-workspace.yaml` marker). */
  private repoRoot(): string {
    const fromEnv = this.env.get('REPO_ROOT');
    if (fromEnv) return fromEnv;
    let dir = __dirname;
    for (let i = 0; i < 12; i++) {
      if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(
      'could not locate the repo root (no pnpm-workspace.yaml above the workspace module) — ' +
        'set REPO_ROOT to the directory containing backend/src/daemon/Dockerfile.',
    );
  }
}
