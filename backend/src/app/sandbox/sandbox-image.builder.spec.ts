import type { EnvService } from '@core/config/env/env.service';
import { describe, expect, it, vi } from 'vitest';
import type { BuildImageSpec, ContainerEngine } from './container-engine.port';
import { SandboxImageBuilder } from './sandbox-image.builder';

const env = (v: Record<string, string | undefined> = {}) =>
  ({ get: (k: string) => v[k] }) as unknown as EnvService;

/** A fake engine that returns scripted image labels and records `buildImage` calls (args included). */
function engineWith(labels: Record<string, string> | null) {
  const buildImage = vi.fn(async (_spec: BuildImageSpec) => {});
  const imageLabels = vi.fn(async () => labels);
  const engine = { imageLabels, buildImage } as unknown as ContainerEngine;
  return { engine, buildImage, imageLabels };
}

/** The context hash the builder computes for the real image dir — captured via one no-label build. */
async function currentHash(): Promise<string> {
  const { engine, buildImage } = engineWith(null);
  await new SandboxImageBuilder(env(), engine).ensureImage();
  return buildImage.mock.calls[0][0].buildArgs?.ATLAS_CONTEXT_HASH ?? '';
}

describe('SandboxImageBuilder.ensureImage — auto-rebuild on context change', () => {
  it('skips the build when the image label matches the current context hash', async () => {
    const hash = await currentHash();
    const { engine, buildImage, imageLabels } = engineWith({ 'atlas.context-hash': hash });

    await new SandboxImageBuilder(env(), engine).ensureImage();

    expect(imageLabels).toHaveBeenCalled();
    expect(buildImage).not.toHaveBeenCalled();
  });

  it('rebuilds with the fresh hash as a build arg when the image label is stale', async () => {
    const { engine, buildImage } = engineWith({ 'atlas.context-hash': 'stale0000000' });

    await new SandboxImageBuilder(env(), engine).ensureImage();

    expect(buildImage).toHaveBeenCalledOnce();
    const arg = buildImage.mock.calls[0][0];
    expect(arg.buildArgs?.ATLAS_CONTEXT_HASH).toMatch(/^[0-9a-f]{12}$/);
    expect(arg.buildArgs?.ATLAS_CONTEXT_HASH).not.toBe('stale0000000');
  });

  it('builds when the image is absent (no labels to read)', async () => {
    const { engine, buildImage } = engineWith(null);

    await new SandboxImageBuilder(env(), engine).ensureImage();

    expect(buildImage).toHaveBeenCalledOnce();
  });

  it('forces a rebuild WITHOUT a label read when SANDBOX_REBUILD is set', async () => {
    const { engine, buildImage, imageLabels } = engineWith({ 'atlas.context-hash': 'anything' });

    await new SandboxImageBuilder(env({ SANDBOX_REBUILD: '1' }), engine).ensureImage();

    expect(buildImage).toHaveBeenCalledOnce();
    expect(imageLabels).not.toHaveBeenCalled();
  });

  it('dedupes concurrent attaches onto a single build', async () => {
    const { engine, buildImage } = engineWith(null);
    const builder = new SandboxImageBuilder(env(), engine);

    await Promise.all([builder.ensureImage(), builder.ensureImage(), builder.ensureImage()]);

    expect(buildImage).toHaveBeenCalledOnce();
  });
});
