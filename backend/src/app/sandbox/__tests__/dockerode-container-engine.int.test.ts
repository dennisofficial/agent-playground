import type { EnvService } from '@core/config/env/env.service';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerodeContainerEngine } from '../dockerode-container-engine';
import { SandboxImageBuilder } from '../sandbox-image.builder';


const env = { get: () => undefined } as unknown as EnvService;

let dockerUp = false;
beforeAll(async () => {
  try {
    await new Docker().ping();
    dockerUp = true;
  } catch {
    dockerUp = false;
  }
});

describe('DockerodeContainerEngine (integration, needs Docker)', () => {
  const engine = new DockerodeContainerEngine(env);
  const builder = new SandboxImageBuilder(env, engine);
  const name = `atlas-sbx-it-${Date.now().toString(36)}`;
  const network = `${name}-net`;
  const volume = `${name}-dind`;
  let id: string | undefined;

  afterAll(async () => {
    if (id) await engine.remove(id, { force: true }).catch(() => undefined);
    try {
      await new Docker().getVolume(volume).remove({ force: true });
    } catch {
    }
  });

  it('builds image, runs a privileged DinD sandbox, execs, and lists by label', async () => {
    if (!dockerUp) {
      console.warn('Docker not reachable — skipping substrate integration test');
      return;
    }

    const tag = await builder.ensureImage();
    expect(tag).toBeTruthy();

    await engine.ensureNetwork(network);

    id = await engine.createContainer({
      name,
      image: tag,
      network,
      privileged: true,
      volumes: [{ name: volume, path: '/var/lib/docker' }],
      labels: { 'atlas.test': '1', 'atlas.job': name },
    });
    expect(id).toBeTruthy();
    await engine.start(id);

    const echo = await engine.exec(id, ['echo', 'exec-ok']);
    expect(echo.exitCode).toBe(0);
    expect(echo.stdout).toContain('exec-ok');

    let innerReady = false;
    for (let i = 0; i < 40; i++) {
      const info = await engine.exec(id, ['docker', 'info', '--format', '{{.ServerVersion}}']);
      if (info.exitCode === 0 && info.stdout.trim()) {
        innerReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(innerReady).toBe(true);

    const listed = await engine.list({ label: 'atlas.job=' + name });
    expect(listed.some((c) => c.id.startsWith(id!.slice(0, 12)))).toBe(true);

    const info = await engine.inspect(id);
    expect(info?.labels['atlas.test']).toBe('1');

    await engine.stop(id, { timeoutSec: 3 });
    await engine.remove(id, { force: true });
    id = undefined;
    expect(await engine.inspect(name)).toBeNull();
  }, 600_000);
});
