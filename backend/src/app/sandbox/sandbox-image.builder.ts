import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleMcpBridge, bundleMcpHub, ensureEngineApp, sandboxContextDir } from './bundle-engine';
import { CONTAINER_ENGINE, type ContainerEngine } from './container-engine.port';

const CONTEXT_HASH_LABEL = 'atlas.context-hash';

const CONTEXT_FILES = [
  'Dockerfile',
  'sandbox-init.sh',
  'shell-init.sh',
  'atlas-svc',
  'atlas-tx',
  'atlas-lsp-server.mjs',
] as const;

@Injectable()
export class SandboxImageBuilder implements OnApplicationBootstrap {
  private readonly logger = new Logger(SandboxImageBuilder.name);

  constructor(
    private readonly env: EnvService,
    @Inject(CONTAINER_ENGINE) private readonly engine: ContainerEngine,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
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
      this.logger.warn(`mcp-bridge rebundle skipped (using existing bundle): ${err}`);
    }
    try {
      const out = await bundleMcpHub();
      this.logger.log(`refreshed mcp-hub bundle → ${out}`);
    } catch (err) {
      this.logger.warn(`mcp-hub rebundle skipped (using existing bundle): ${err}`);
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
    return this.env.get('SANDBOX_IMAGE') ?? 'atlas-sandbox:latest';
  }

  contextDir(): string {
    return sandboxContextDir();
  }

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

  private contextHash(): string {
    const dir = this.contextDir();
    const h = createHash('sha256');
    for (const f of CONTEXT_FILES)
      h.update(f)
        .update('\0')
        .update(readFileSync(join(dir, f)));
    return h.digest('hex').slice(0, 12);
  }

  private inFlight?: Promise<string>;

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
      this.logger.log(`sandbox image ${tag} up to date (context ${hash}) — skipping build`);
      return tag;
    }
    if (labels) {
      this.logger.log(
        `sandbox image ${tag} context changed (${labels[CONTEXT_HASH_LABEL] ?? 'unlabelled'} → ${hash}) — rebuilding`,
      );
    }
    onBuildStart?.();
    this.logger.log(`building sandbox image ${tag} (context ${hash}; slow on first run)…`);
    await this.engine.buildImage({
      contextDir: this.contextDir(),
      tag,
      buildArgs: { ATLAS_CONTEXT_HASH: hash },
      onProgress: (line) => this.logger.debug(line),
    });
    this.logger.log(`built sandbox image ${tag} (context ${hash})`);
    return tag;
  }
}
