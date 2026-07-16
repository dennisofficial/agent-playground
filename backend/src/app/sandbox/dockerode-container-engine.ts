import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import Docker from 'dockerode';
import { readdirSync } from 'node:fs';
import { Writable } from 'node:stream';
import type {
  BuildImageSpec,
  ContainerEngine,
  ContainerInfo,
  CreateContainerSpec,
  DetachedExecOptions,
  ExecOptions,
  ExecResult,
  NetworkInfo,
  VolumeInfo,
} from './container-engine.port';

/**
 * The `dockerode` implementation of {@link ContainerEngine}. The single place that touches the Docker
 * API. Connects to the host daemon over its unix socket (DOCKER_SOCKET_PATH ?? DOCKER_SOCKET_PATH,
 * else dockerode's default `/var/run/docker.sock`). Clean-room — no `harness/**` import.
 */
@Injectable()
export class DockerodeContainerEngine implements ContainerEngine {
  private readonly logger = new Logger(DockerodeContainerEngine.name);
  private readonly docker: Docker;

  constructor(private readonly env: EnvService) {
    const socketPath = this.env.get('DOCKER_SOCKET_PATH');
    this.docker = socketPath ? new Docker({ socketPath }) : new Docker();
  }

  async ensureNetwork(name: string): Promise<void> {
    const existing = await this.docker.listNetworks({
      filters: { name: [name] },
    });
    // listNetworks name filter is a substring match — require an exact name hit.
    if (existing.some((n) => n.Name === name)) return;
    try {
      await this.docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        CheckDuplicate: true,
      });
      this.logger.log(`created network ${name}`);
    } catch (err) {
      // A concurrent create may have won the race — tolerate "already exists".
      if (!/already exists/i.test(String(err))) throw err;
    }
  }

  async imageExists(tag: string): Promise<boolean> {
    try {
      await this.docker.getImage(tag).inspect();
      return true;
    } catch {
      return false;
    }
  }

  async imageId(tag: string): Promise<string | null> {
    try {
      const info = await this.docker.getImage(tag).inspect();
      return info.Id ?? null;
    } catch {
      return null;
    }
  }

  async imageLabels(tag: string): Promise<Record<string, string> | null> {
    try {
      const info = await this.docker.getImage(tag).inspect();
      return info.Config?.Labels ?? {};
    } catch {
      return null;
    }
  }

  async buildImage(spec: BuildImageSpec): Promise<void> {
    const src = readdirSync(spec.contextDir);
    const stream = await this.docker.buildImage(
      { context: spec.contextDir, src },
      {
        t: spec.tag,
        dockerfile: spec.dockerfile ?? 'Dockerfile',
        // Always remove intermediate build containers, even when a build STEP FAILS
        // (`rm` alone only cleans up on success). Without forcerm, a failed/interrupted
        // sandbox-image build leaves orphaned intermediate containers (random names, no
        // labels) that pin their image layers on the box — the leak docker-gc.sh's stray
        // reap otherwise has to mop up. See infra/docker-gc.sh step 0.
        rm: true,
        forcerm: true,
        ...(spec.buildArgs ? { buildargs: spec.buildArgs } : {}),
      },
    );
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err, _res) => (err ? reject(err) : resolve()),
        (evt: { stream?: string; error?: string }) => {
          if (evt.error) {
            this.logger.error(`build error: ${evt.error}`);
            return;
          }
          const line = evt.stream?.replace(/\n$/, '');
          if (line) spec.onProgress?.(line);
        },
      );
    });
  }

  async createContainer(spec: CreateContainerSpec): Promise<string> {
    const container = await this.docker.createContainer({
      Image: spec.image,
      name: spec.name,
      ...(spec.labels ? { Labels: spec.labels } : {}),
      ...(spec.env ? { Env: toEnvList(spec.env) } : {}),
      ...(spec.cmd ? { Cmd: spec.cmd } : {}),
      ...(spec.workingDir ? { WorkingDir: spec.workingDir } : {}),
      ...(spec.ports ? { ExposedPorts: toExposedPorts(spec.ports) } : {}),
      HostConfig: {
        ...(spec.binds ? { Binds: spec.binds } : {}),
        ...(spec.network ? { NetworkMode: spec.network } : {}),
        ...(spec.privileged ? { Privileged: true } : {}),
        ...(spec.init ? { Init: true } : {}),
        ...(spec.cpuShares ? { CpuShares: spec.cpuShares } : {}),
        ...(spec.nanoCpus ? { NanoCpus: spec.nanoCpus } : {}),
        ...(spec.memoryBytes ? { Memory: spec.memoryBytes } : {}),
        ...(spec.pidsLimit ? { PidsLimit: spec.pidsLimit } : {}),
        ...(spec.volumes
          ? {
              Mounts: spec.volumes.map((v) => ({
                Type: 'volume' as const,
                Source: v.name,
                Target: v.path,
              })),
            }
          : {}),
        ...(spec.ports ? { PortBindings: toPortBindings(spec.ports) } : {}),
      },
    });
    return container.id;
  }

  async start(id: string): Promise<void> {
    await this.docker.getContainer(id).start();
  }

  async exec(
    id: string,
    argv: string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    const needsStdin =
      opts.stdin !== undefined || opts.onStdinReady !== undefined;
    const exec = await this.docker.getContainer(id).exec({
      Cmd: argv,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: needsStdin,
      Tty: false,
      ...(opts.user ? { User: opts.user } : {}),
      ...(opts.env ? { Env: toEnvList(opts.env) } : {}),
      ...(opts.cwd ? { WorkingDir: opts.cwd } : {}),
    });

    const stream = await exec.start({ hijack: true, stdin: needsStdin });

    let stdout = '';
    let stderr = '';
    const outW = new Writable({
      write: (chunk, _enc, cb) => {
        const s = chunk.toString('utf8');
        stdout += s;
        opts.onStdout?.(s);
        cb();
      },
    });
    const errW = new Writable({
      write: (chunk, _enc, cb) => {
        const s = chunk.toString('utf8');
        stderr += s;
        opts.onStderr?.(s);
        cb();
      },
    });
    this.docker.modem.demuxStream(stream, outW, errW);

    if (opts.stdin !== undefined) {
      // One-shot: write the whole payload then close stdin immediately.
      stream.write(opts.stdin);
      stream.end();
    } else if (opts.onStdinReady) {
      // Bidirectional: hand the caller a write/end handle; caller decides when stdin closes.
      opts.onStdinReady(
        (data) => stream.write(data),
        () => stream.end(),
      );
    }

    const onAbort = (): void => {
      stream.destroy();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      await new Promise<void>((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('close', resolve);
        stream.on('error', reject);
      });
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }

    const info = await exec.inspect();
    return { exitCode: info.ExitCode ?? 0, stdout, stderr };
  }

  async connectNetwork(id: string, network: string): Promise<void> {
    try {
      await this.docker.getNetwork(network).connect({ Container: id });
    } catch (err) {
      // Already attached → Docker 403 "endpoint ... already exists" / "already exists in network".
      if (!/already exists|already connected/i.test(String(err))) throw err;
    }
  }

  async disconnectNetwork(id: string, network: string): Promise<void> {
    try {
      await this.docker
        .getNetwork(network)
        .disconnect({ Container: id, Force: true });
    } catch (err) {
      // Not on the network / no such network/container → already in the desired state.
      if (!/not connected|no such|is not connected|404/i.test(String(err)))
        throw err;
    }
  }

  async execDetached(
    id: string,
    argv: string[],
    opts: DetachedExecOptions = {},
  ): Promise<{ pid?: number }> {
    // TRUE detachment: AttachStd*:false + Detach:true runs the command in the BACKGROUND inside the
    // container (owned by the daemon), NOT tied to this client connection — so it keeps running when the
    // backend process dies. (An attached `hijack` start would be KILLED when the backend's socket drops,
    // which defeats restart-survival.) The engine reads its spec from / reports over Redis, so it needs
    // no stdio from us. See ADR 0001.
    const exec = await this.docker.getContainer(id).exec({
      Cmd: argv,
      AttachStdout: false,
      AttachStderr: false,
      AttachStdin: false,
      Tty: false,
      ...(opts.user ? { User: opts.user } : {}),
      ...(opts.env ? { Env: toEnvList(opts.env) } : {}),
      ...(opts.cwd ? { WorkingDir: opts.cwd } : {}),
    });
    await exec.start({ Detach: true });
    const info = await exec.inspect().catch(() => undefined);
    return { pid: info?.Pid && info.Pid > 0 ? info.Pid : undefined };
  }

  async stop(id: string, opts: { timeoutSec?: number } = {}): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: opts.timeoutSec ?? 10 });
    } catch (err) {
      // 304 = already stopped; 404 = already gone — both fine.
      if (
        !/already stopped|not running|no such container|404|304/i.test(
          String(err),
        )
      )
        throw err;
    }
  }

  async remove(id: string, opts: { force?: boolean } = {}): Promise<void> {
    try {
      await this.docker
        .getContainer(id)
        .remove({ force: opts.force ?? true, v: false });
    } catch (err) {
      if (!/no such container|404/i.test(String(err))) throw err;
    }
  }

  async removeNetwork(name: string): Promise<void> {
    try {
      await this.docker.getNetwork(name).remove();
    } catch (err) {
      // 404 = already gone — fine. An "active endpoints" error means a container still holds it; let
      // the caller (best-effort cleanup) decide whether to swallow it.
      if (!/no such network|not found|404/i.test(String(err))) throw err;
    }
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).remove();
    } catch (err) {
      // 404 = already gone — fine. An "in use" error means a container still mounts it; let the caller
      // (best-effort cleanup) decide whether to swallow it.
      if (!/no such volume|not found|404/i.test(String(err))) throw err;
    }
  }

  async list(
    opts: { label?: string | string[]; all?: boolean } = {},
  ): Promise<ContainerInfo[]> {
    const labels = opts.label
      ? Array.isArray(opts.label)
        ? opts.label
        : [opts.label]
      : undefined;
    const raw = await this.docker.listContainers({
      all: opts.all ?? true,
      ...(labels ? { filters: { label: labels } } : {}),
    });
    return raw.map((c) => ({
      id: c.Id,
      name: (c.Names?.[0] ?? '').replace(/^\//, ''),
      state: c.State,
      labels: c.Labels ?? {},
      startedAt: null, // list summaries don't carry State.StartedAt — use inspect() when needed
    }));
  }

  async systemDf(): Promise<{
    imagesBytes: number;
    containersBytes: number;
    volumesBytes: number;
    buildCacheBytes: number;
    totalBytes: number;
  }> {
    // `@types/dockerode` doesn't type `df()` — declare the payload shape locally and cast. Verified
    // against a live daemon (API 1.55): sizes live in different per-type fields (images `Size` /
    // `LayersSize` dedup total, containers `SizeRw` writable layer, volumes `UsageData.Size`, build
    // cache `Size`); every field is defensively `?? 0` since none are guaranteed present.
    const df = (await this.docker.df()) as {
      LayersSize?: number;
      Images?: { Size?: number }[];
      Containers?: { SizeRw?: number }[];
      Volumes?: { UsageData?: { Size?: number } }[];
      BuildCache?: { Size?: number }[];
    };
    const sum = (ns: (number | undefined)[]): number =>
      ns.reduce<number>((a, n) => a + (n ?? 0), 0);
    const imagesBytes =
      df.LayersSize && df.LayersSize > 0
        ? df.LayersSize
        : sum((df.Images ?? []).map((i) => i.Size));
    const containersBytes = sum((df.Containers ?? []).map((c) => c.SizeRw));
    const volumesBytes = sum((df.Volumes ?? []).map((v) => v.UsageData?.Size));
    const buildCacheBytes = sum((df.BuildCache ?? []).map((b) => b.Size));
    const totalBytes =
      imagesBytes + containersBytes + volumesBytes + buildCacheBytes;
    return {
      imagesBytes,
      containersBytes,
      volumesBytes,
      buildCacheBytes,
      totalBytes,
    };
  }

  async listNetworks(): Promise<NetworkInfo[]> {
    const raw = await this.docker.listNetworks();
    return raw.map((n) => ({ id: n.Id, name: n.Name }));
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    const res = await this.docker.listVolumes();
    return (res.Volumes ?? []).map((v) => ({ name: v.Name }));
  }

  async inspect(idOrName: string): Promise<ContainerInfo | null> {
    try {
      const info = await this.docker.getContainer(idOrName).inspect();
      // Docker reports StartedAt as the zero-time '0001-01-01T00:00:00Z' for a never-started container;
      // normalize that to null so callers don't treat it as a real boot time.
      const started = info.State?.StartedAt;
      const startedAt =
        started && !started.startsWith('0001-01-01') ? started : null;
      return {
        id: info.Id,
        name: (info.Name ?? '').replace(/^\//, ''),
        state: info.State?.Status ?? 'unknown',
        labels: info.Config?.Labels ?? {},
        startedAt,
      };
    } catch {
      return null;
    }
  }
}

/** `{K:V}` → `["K=V"]` for the Docker API. */
function toEnvList(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function toExposedPorts(
  ports: CreateContainerSpec['ports'],
): Record<string, Record<string, never>> {
  const out: Record<string, Record<string, never>> = {};
  for (const p of ports ?? [])
    out[`${p.containerPort}/${p.protocol ?? 'tcp'}`] = {};
  return out;
}

function toPortBindings(
  ports: CreateContainerSpec['ports'],
): Record<string, Array<{ HostPort: string }>> {
  const out: Record<string, Array<{ HostPort: string }>> = {};
  for (const p of ports ?? []) {
    out[`${p.containerPort}/${p.protocol ?? 'tcp'}`] = [
      { HostPort: p.hostPort ? String(p.hostPort) : '' },
    ];
  }
  return out;
}
