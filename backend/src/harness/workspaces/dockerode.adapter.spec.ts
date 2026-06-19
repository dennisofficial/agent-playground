/**
 * `DockerodeAdapter` create-spec → dockerode-options MAPPING tests — no Docker socket. We inject a fake
 * `dockerode` client (the adapter's lazily-constructed `client` field) and assert the exact options it
 * passes to `createContainer`. The load-bearing concern here is Phase 2's dev-server PORT mapping:
 * `spec.ports` → `ExposedPorts` ("<port>/tcp": {}) + `HostConfig.PortBindings` ("<port>/tcp":
 * [{ HostIp, HostPort }]), with `PublishAllPorts` always false; and that NO ports leaves both absent.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { CreateContainerSpec } from './container-engine.port';
import { DockerodeAdapter } from './dockerode.adapter';

/** A minimal spec with the always-present fields the mapping needs (ports added per test). */
function baseSpec(over: Partial<CreateContainerSpec> = {}): CreateContainerSpec {
  return {
    name: 'agent-ws-x',
    image: 'img',
    env: [],
    labels: { 'com.agent.managed': '1' },
    privileged: true,
    binds: [],
    restartPolicy: 'unless-stopped',
    ...over,
  };
}

/** Build the adapter with its private `client` replaced by a fake whose `createContainer` records the
 * options it was called with (and returns a handle-ish object). Returns the spy for assertions. */
function adapterWithFakeClient() {
  const created = vi.fn(async (_opts: Record<string, unknown>) => ({
    id: 'container-id-1',
  }));
  const adapter = new DockerodeAdapter({
    get: () => undefined,
  } as unknown as EnvService);
  // Inject the fake client (the adapter constructs it lazily; we pre-seed `client` to skip the socket).
  (adapter as unknown as { client: unknown }).client = {
    createContainer: created,
  };
  return { adapter, created };
}

describe('DockerodeAdapter port mapping', () => {
  it('maps spec.ports → ExposedPorts + HostConfig.PortBindings (localhost-only), PublishAllPorts false', async () => {
    const { adapter, created } = adapterWithFakeClient();
    await adapter.createContainer(
      baseSpec({
        ports: [{ hostIp: '127.0.0.1', hostPort: 39000, containerPort: 7000 }],
      }),
    );

    const opts = created.mock.calls[0][0] as {
      ExposedPorts?: Record<string, unknown>;
      HostConfig: {
        PortBindings?: Record<string, Array<{ HostIp?: string; HostPort: string }>>;
        PublishAllPorts: boolean;
      };
    };
    expect(opts.ExposedPorts).toEqual({ '7000/tcp': {} });
    expect(opts.HostConfig.PortBindings).toEqual({
      '7000/tcp': [{ HostIp: '127.0.0.1', HostPort: '39000' }],
    });
    // We bind explicitly — never "publish all".
    expect(opts.HostConfig.PublishAllPorts).toBe(false);
  });

  it('defaults HostIp to 127.0.0.1 when the spec omits it (never 0.0.0.0)', async () => {
    const { adapter, created } = adapterWithFakeClient();
    await adapter.createContainer(
      baseSpec({ ports: [{ hostPort: 39005, containerPort: 7000 }] }),
    );
    const opts = created.mock.calls[0][0] as {
      HostConfig: { PortBindings?: Record<string, Array<{ HostIp?: string }>> };
    };
    expect(opts.HostConfig.PortBindings!['7000/tcp'][0].HostIp).toBe('127.0.0.1');
  });

  it('NO ports → no ExposedPorts / no PortBindings (historical behavior), PublishAllPorts still false', async () => {
    const { adapter, created } = adapterWithFakeClient();
    await adapter.createContainer(baseSpec());
    const opts = created.mock.calls[0][0] as {
      ExposedPorts?: unknown;
      HostConfig: { PortBindings?: unknown; PublishAllPorts: boolean };
    };
    expect(opts.ExposedPorts).toBeUndefined();
    expect(opts.HostConfig.PortBindings).toBeUndefined();
    expect(opts.HostConfig.PublishAllPorts).toBe(false);
  });
});

describe('DockerodeAdapter.restartContainer — docker restart (never recreate)', () => {
  it('calls getContainer(id).restart() and never remove/recreate', async () => {
    const restart = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const getContainer = vi.fn((_id: string) => ({ restart, remove }));
    const adapter = new DockerodeAdapter({
      get: () => undefined,
    } as unknown as EnvService);
    (adapter as unknown as { client: unknown }).client = { getContainer };

    await adapter.restartContainer('c-stale');

    expect(getContainer).toHaveBeenCalledWith('c-stale');
    expect(restart).toHaveBeenCalledTimes(1);
    // The clone lives in the writable layer — a restart must NEVER fall back to remove/recreate.
    expect(remove).not.toHaveBeenCalled();
  });
});
