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
    const { engine, buildImage, imageLabels } = engineWith({
      'atlas.context-hash': hash,
    });

    await new SandboxImageBuilder(env(), engine).ensureImage();

    expect(imageLabels).toHaveBeenCalled();
    expect(buildImage).not.toHaveBeenCalled();
  });

  it('rebuilds with the fresh hash as a build arg when the image label is stale', async () => {
    const { engine, buildImage } = engineWith({
      'atlas.context-hash': 'stale0000000',
    });

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

  it('dedupes concurrent attaches onto a single build', async () => {
    const { engine, buildImage } = engineWith(null);
    const builder = new SandboxImageBuilder(env(), engine);

    await Promise.all([
      builder.ensureImage(),
      builder.ensureImage(),
      builder.ensureImage(),
    ]);

    expect(buildImage).toHaveBeenCalledOnce();
  });

  it('fires onBuildStart exactly once when a real rebuild happens (stale label)', async () => {
    const { engine } = engineWith({ 'atlas.context-hash': 'stale0000000' });
    const onBuildStart = vi.fn();

    await new SandboxImageBuilder(env(), engine).ensureImage(onBuildStart);

    expect(onBuildStart).toHaveBeenCalledOnce();
  });

  it('fires onBuildStart exactly once when the image is absent', async () => {
    const { engine } = engineWith(null);
    const onBuildStart = vi.fn();

    await new SandboxImageBuilder(env(), engine).ensureImage(onBuildStart);

    expect(onBuildStart).toHaveBeenCalledOnce();
  });

  it('never fires onBuildStart on the fast label-match skip', async () => {
    const hash = await currentHash();
    const { engine } = engineWith({ 'atlas.context-hash': hash });
    const onBuildStart = vi.fn();

    await new SandboxImageBuilder(env(), engine).ensureImage(onBuildStart);

    expect(onBuildStart).not.toHaveBeenCalled();
  });

  it("only the FIRST concurrent caller's onBuildStart fires (best-effort, not exactly-once-per-caller)", async () => {
    const { engine, buildImage } = engineWith(null);
    const builder = new SandboxImageBuilder(env(), engine);
    const first = vi.fn();
    const second = vi.fn();

    await Promise.all([
      builder.ensureImage(first),
      builder.ensureImage(second),
    ]);

    expect(buildImage).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });
});

describe('SandboxImageBuilder.onApplicationBootstrap', () => {
  it('resolves without waiting for the background image warm-up to finish', async () => {
    let resolveBuild!: () => void;
    const buildImage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveBuild = resolve;
        }),
    );
    const engine = {
      imageLabels: vi.fn(async () => null),
      buildImage,
    } as unknown as ContainerEngine;
    const builder = new SandboxImageBuilder(env(), engine);

    // If the hook AWAITED ensureImage(), this would hang past Vitest's default test timeout, since
    // buildImage's promise never resolves — it doesn't hang: this line completes on its own.
    await builder.onApplicationBootstrap();

    resolveBuild!(); // let the background build finish so it doesn't leak into later tests
  });

  it('kicks off ensureImage() in the background', async () => {
    const { engine, buildImage } = engineWith(null);
    const builder = new SandboxImageBuilder(env(), engine);

    await builder.onApplicationBootstrap();

    await vi.waitFor(() => expect(buildImage).toHaveBeenCalled());
  });

  it('never rejects even when the background image warm-up fails', async () => {
    const buildImage = vi.fn(async () => {
      throw new Error('boom');
    });
    const engine = {
      imageLabels: vi.fn(async () => null),
      buildImage,
    } as unknown as ContainerEngine;
    const builder = new SandboxImageBuilder(env(), engine);

    await expect(builder.onApplicationBootstrap()).resolves.toBeUndefined();
    // The background failure is caught internally (logged, not thrown) — confirm the path actually ran.
    await vi.waitFor(() => expect(buildImage).toHaveBeenCalled());
  });
});
