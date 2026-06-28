import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { join } from 'node:path';
import { bundleEngine } from './bundle-engine';
import { CONTAINER_ENGINE, type ContainerEngine } from './container-engine.port';

/**
 * Boot-memoized build of the sandbox base image. `ensureImage()` is idempotent: it skips the (slow)
 * build when the tag already exists locally, unless `SANDBOX_REBUILD` is set. The image tag comes
 * from `WORKSPACE_IMAGE` (else a sane default). The build context is the colocated `image/` dir
 * (Dockerfile + sandbox-init.sh + — from D1 — the engine bundle).
 *
 * On bootstrap it also REBUNDLES the engine entrypoint (`bundleEngine`) so the API itself keeps the
 * engine current — a dev watch-restart or a prod deploy-restart refreshes it with no manual bundle step
 * or SSH. The bundle is bind-mounted live into every sandbox (see `SandboxManager`), so the refresh
 * reaches running threads on their next turn. Best-effort: if bundling can't run (e.g. esbuild/source
 * absent), it logs and falls back to the existing bundle / the baked image.
 *
 * NOTE: in a compiled prod build, `nest-cli.json` must copy `sandbox/image/**` as assets so this path
 * resolves; under ts-node / vitest `__dirname` is the source dir, so it resolves as-is.
 */
@Injectable()
export class SandboxImageBuilder implements OnApplicationBootstrap {
  private readonly logger = new Logger(SandboxImageBuilder.name);

  constructor(
    private readonly env: EnvService,
    @Inject(CONTAINER_ENGINE) private readonly engine: ContainerEngine,
  ) {}

  /** Refresh the engine bundle on boot so engine updates flow without a manual rebundle. Best-effort. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const out = await bundleEngine();
      this.logger.log(`refreshed engine bundle → ${out}`);
    } catch (err) {
      this.logger.warn(`engine rebundle skipped (using existing bundle): ${err}`);
    }
  }

  imageTag(): string {
    // NB: a dedicated var — NOT v1's WORKSPACE_IMAGE, which often still points at the deleted v1
    // workspace base image and would run a container with no `atlas-engine-turn` entrypoint.
    return this.env.get('SANDBOX_IMAGE') ?? 'atlas-sandbox:latest';
  }

  contextDir(): string {
    return join(__dirname, 'image');
  }

  /** Ensure the base image exists locally; build it if missing (or if `SANDBOX_REBUILD`). */
  async ensureImage(): Promise<string> {
    const tag = this.imageTag();
    const rebuild = !!this.env.get('SANDBOX_REBUILD');
    if (!rebuild && (await this.engine.imageExists(tag))) {
      this.logger.log(`sandbox image ${tag} present — skipping build`);
      return tag;
    }
    this.logger.log(`building sandbox image ${tag} (this is slow on first run)…`);
    await this.engine.buildImage({
      contextDir: this.contextDir(),
      tag,
      onProgress: (line) => this.logger.debug(line),
    });
    this.logger.log(`built sandbox image ${tag}`);
    return tag;
  }
}
