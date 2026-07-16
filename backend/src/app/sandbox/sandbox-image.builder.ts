import { EnvService } from '@core/config/env/env.service';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bundleEngine,
  bundleMcpBridge,
  bundleMcpHub,
  ensureEngineApp,
  sandboxContextDir,
} from './bundle-engine';
import {
  CONTAINER_ENGINE,
  type ContainerEngine,
} from './container-engine.port';

/** The image label that carries the build-context hash — the signal for auto-rebuild-on-change. */
const CONTEXT_HASH_LABEL = 'atlas.context-hash';

/**
 * The STATIC files whose content defines the baked image; the image is rebuilt iff their combined hash
 * changes. `engine-entrypoint.mjs` is deliberately EXCLUDED: it's re-bundled on every boot and
 * bind-mounted live into each sandbox, so folding its churn into the hash would rebuild the image (and,
 * via the imageId fingerprint, recreate every sandbox container) on every restart for no real change.
 */
const CONTEXT_FILES = [
  'Dockerfile',
  'sandbox-init.sh',
  'shell-init.sh',
  'atlas-svc',
  'atlas-tx',
  'atlas-lsp-server.mjs',
] as const;

/**
 * Build of the sandbox base image. `ensureImage()` is idempotent AND change-aware: it hashes the static
 * build-context files and bakes that hash into the image as a label, so it rebuilds automatically when
 * the Dockerfile / shell scripts change and otherwise skips the (slow) build after a fast label read.
 * The image tag comes from `SANDBOX_IMAGE` (else a sane default). The build context is the fixed `backend/sandbox/` dir
 * (Dockerfile + sandbox-init.sh + shell-init.sh + the engine bundle written there at boot).
 *
 * On bootstrap it also REBUNDLES the engine entrypoint (`bundleEngine`) so the API itself keeps the
 * engine current — a dev watch-restart or a prod deploy-restart refreshes it with no manual bundle step
 * or SSH. The bundle is bind-mounted live into every sandbox (see `SandboxManager`), so the refresh
 * reaches running threads on their next turn. Best-effort: if bundling can't run (e.g. esbuild/source
 * absent), it logs and falls back to the existing bundle / the baked image.
 *
 * NOTE: the build context is the fixed `backend/sandbox/` dir (see `sandboxContextDir`), NOT under
 * `dist`/`src` — so it needs no nest-cli asset copy and is identical at build time and runtime.
 */
@Injectable()
export class SandboxImageBuilder implements OnApplicationBootstrap {
  private readonly logger = new Logger(SandboxImageBuilder.name);

  constructor(
    private readonly env: EnvService,
    @Inject(CONTAINER_ENGINE) private readonly engine: ContainerEngine,
  ) {}

  /**
   * Refresh the engine bundle on boot so engine updates flow without a manual rebundle, then warm the
   * sandbox image in the BACKGROUND (not awaited) — so a Dockerfile/shell-init.sh change gets rebuilt at
   * boot, when nobody is waiting on a chat reply, instead of silently eating the build on the next live
   * thread's first turn (that used to look exactly like "Atlas isn't responding"). `ensureImage()`'s own
   * `inFlight` dedup means a thread that attaches before this finishes just awaits the SAME promise — no
   * duplicate build, no regression vs. today. Never throws either the bundle or the warm-up.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const out = await bundleEngine();
      this.logger.log(`refreshed engine bundle → ${out}`);
    } catch (err) {
      this.logger.warn(
        `engine rebundle skipped (using existing bundle): ${err}`,
      );
    }
    try {
      const { js } = ensureEngineApp();
      this.logger.log(`engine app bundle present → ${js}`);
    } catch (err) {
      this.logger.warn(`engine app bundle missing (using existing/baked): ${err}`);
    }
    try {
      const out = await bundleMcpBridge();
      this.logger.log(`refreshed mcp-bridge bundle → ${out}`);
    } catch (err) {
      this.logger.warn(
        `mcp-bridge rebundle skipped (using existing bundle): ${err}`,
      );
    }
    try {
      const out = await bundleMcpHub();
      this.logger.log(`refreshed mcp-hub bundle → ${out}`);
    } catch (err) {
      this.logger.warn(
        `mcp-hub rebundle skipped (using existing bundle): ${err}`,
      );
    }
    this.logger.log('sandbox image warm-up starting in background');
    void this.ensureImage()
      .then((tag) => this.logger.log(`sandbox image warm-up complete (${tag})`))
      .catch((err) =>
        this.logger.warn(
          `sandbox image warm-up failed (will retry lazily on first attach): ${err}`,
        ),
      );
  }

  imageTag(): string {
    // NB: a dedicated var — NOT v1's WORKSPACE_IMAGE, which often still points at the deleted v1
    // workspace base image and would run a container with no `atlas-engine-turn` entrypoint.
    return this.env.get('SANDBOX_IMAGE') ?? 'atlas-sandbox:latest';
  }

  contextDir(): string {
    return sandboxContextDir();
  }

  /**
   * Preflight: fail with a CLEAR, actionable error if a static context file is missing, instead of a raw
   * ENOENT from the hasher below. The context dir is a fixed committed folder identical in dev and prod,
   * so a missing file means the checkout/deploy is broken (or a file was deleted), not a stale-copy race.
   */
  private ensureContextFiles(): void {
    const dir = this.contextDir();
    for (const f of CONTEXT_FILES) {
      if (existsSync(join(dir, f))) continue;
      throw new Error(
        `sandbox image build-context file '${f}' missing from ${dir}. It is committed under ` +
          'backend/sandbox/ — restore it (git checkout) or check the deploy shipped that dir.',
      );
    }
  }

  /** sha256 (12 hex) over the static build-context files — changes IFF the image definition changed, so
   *  it's the identity `ensureImage` compares against the built image's label to decide on a rebuild. */
  private contextHash(): string {
    const dir = this.contextDir();
    const h = createHash('sha256');
    for (const f of CONTEXT_FILES)
      h.update(f)
        .update('\0')
        .update(readFileSync(join(dir, f)));
    return h.digest('hex').slice(0, 12);
  }

  /** In-flight build/check, so concurrent attaches at boot dedupe onto one build instead of racing. */
  private inFlight?: Promise<string>;

  /**
   * Ensure the base image exists AND matches the current build context. Rebuilds automatically when the
   * static context (Dockerfile + the shell scripts) changed — the image carries its context hash as a
   * label, so an unchanged image is a fast label read, no build. (To bust Docker's OWN layer cache, e.g.
   * to re-pull a floating pnpm/fnm version, `docker rmi` the image or `docker build --no-cache` by hand.)
   *
   * `onBuildStart`, if given, fires ONLY when a real rebuild is about to happen (never on the fast
   * label-match skip) — the caller's signal to narrate "this will take a while" to whoever's waiting.
   * Concurrent callers dedupe via `inFlight`: only the FIRST caller's `onBuildStart` fires for a given
   * in-flight build (best-effort, not exactly-once-per-caller — acceptable, since today NEITHER caller
   * gets any signal at all).
   */
  async ensureImage(onBuildStart?: () => void): Promise<string> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doEnsureImage(onBuildStart).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doEnsureImage(onBuildStart?: () => void): Promise<string> {
    const tag = this.imageTag();
    this.ensureContextFiles(); // self-heal a dist context missing a nest-cli asset before hashing/building
    const hash = this.contextHash();
    const labels = await this.engine.imageLabels(tag);
    if (labels && labels[CONTEXT_HASH_LABEL] === hash) {
      this.logger.log(
        `sandbox image ${tag} up to date (context ${hash}) — skipping build`,
      );
      return tag;
    }
    if (labels) {
      this.logger.log(
        `sandbox image ${tag} context changed (${labels[CONTEXT_HASH_LABEL] ?? 'unlabelled'} → ${hash}) — rebuilding`,
      );
    }
    onBuildStart?.();
    this.logger.log(
      `building sandbox image ${tag} (context ${hash}; slow on first run)…`,
    );
    await this.engine.buildImage({
      contextDir: this.contextDir(),
      tag,
      // Baked into the image as CONTEXT_HASH_LABEL (see the Dockerfile's ARG/LABEL) so the next boot can
      // tell a matching image from a stale one without rebuilding.
      buildArgs: { ATLAS_CONTEXT_HASH: hash },
      onProgress: (line) => this.logger.debug(line),
    });
    this.logger.log(`built sandbox image ${tag} (context ${hash})`);
    return tag;
  }
}
