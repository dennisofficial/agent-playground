import { Injectable, Logger } from '@nestjs/common';
import Docker from 'dockerode';
import { EnvService } from '@core/config/env/env.service';
import type {
  BuildImageSpec,
  ContainerEnginePort,
  ContainerHandle,
  ContainerLabels,
  ContainerSummary,
  CreateContainerSpec,
  ListContainersFilter,
  ListVolumesFilter,
  RunBuildContainerSpec,
  VolumeSummary,
} from './container-engine.port';

/**
 * The production `ContainerEnginePort` binding — a thin wrapper over a `dockerode` client on the host
 * Docker socket (`DOCKER_SOCKET_PATH`, default `/var/run/docker.sock`). This is the ONLY place the host
 * Docker socket is touched (the manager holds only this port); the spec→dockerode mapping lives here so
 * `ContainerManagerService` stays engine-agnostic and the create shape is asserted against the fake.
 *
 * The client is constructed lazily on first use, so importing the host workspaces module never fails
 * boot when Docker is absent (mirrors the lazy/resilient Redis client) — the socket is only opened when
 * a sandbox is actually spawned/reconciled, and a Docker-absent error surfaces at that call, not at boot.
 */
@Injectable()
export class DockerodeAdapter implements ContainerEnginePort {
  private readonly logger = new Logger(DockerodeAdapter.name);
  private client?: Docker;

  constructor(private readonly env: EnvService) {}

  private docker(): Docker {
    if (!this.client) {
      const socketPath =
        this.env.get('DOCKER_SOCKET_PATH') ?? '/var/run/docker.sock';
      this.client = new Docker({ socketPath });
      this.logger.log(`Docker client bound to socket ${socketPath}`);
    }
    return this.client;
  }

  async createContainer(spec: CreateContainerSpec): Promise<ContainerHandle> {
    // Explicit port publishes (reserved at CREATE — Docker can't add a mapping to a running container).
    // `spec.ports` maps each container port → a host `ip:port`; we set BOTH dockerode forms it needs:
    // `ExposedPorts["<port>/tcp"] = {}` and `HostConfig.PortBindings["<port>/tcp"] = [{ HostIp, HostPort }]`.
    // The manager only ever passes the single localhost-only dev-server port; `PublishAllPorts` stays false
    // (we bind EXPLICITLY, never "publish all"). No ports → both maps stay empty (historical behavior).
    const ports = spec.ports ?? [];
    const exposedPorts: Record<string, Record<string, never>> = {};
    const portBindings: Record<
      string,
      Array<{ HostIp?: string; HostPort: string }>
    > = {};
    for (const p of ports) {
      const key = `${p.containerPort}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [
        { HostIp: p.hostIp ?? '127.0.0.1', HostPort: String(p.hostPort) },
      ];
    }
    const container = await this.docker().createContainer({
      name: spec.name,
      Image: spec.image,
      Env: spec.env,
      Labels: spec.labels,
      // Join a named network so the daemon can reach the compose Redis by service DNS. Both forms are
      // set: HostConfig.NetworkMode (the primary attach) AND a NetworkingConfig.EndpointsConfig entry
      // (so the network is attached even when NetworkMode is otherwise interpreted) — they agree on the
      // same network name. Undefined → omit both (Docker's default bridge).
      ...(spec.network
        ? {
            NetworkingConfig: {
              EndpointsConfig: { [spec.network]: {} },
            },
          }
        : {}),
      // ExposedPorts only when the spec asks for an explicit publish (the single localhost dev-server port).
      ...(ports.length ? { ExposedPorts: exposedPorts } : {}),
      HostConfig: {
        Privileged: spec.privileged,
        ...(spec.runtime ? { Runtime: spec.runtime } : {}),
        ...(spec.network ? { NetworkMode: spec.network } : {}),
        Binds: spec.binds,
        RestartPolicy: { Name: spec.restartPolicy },
        ...(spec.memoryBytes !== undefined
          ? { Memory: spec.memoryBytes }
          : {}),
        ...(spec.nanoCpus !== undefined ? { NanoCpus: spec.nanoCpus } : {}),
        ...(spec.pidsLimit !== undefined
          ? { PidsLimit: spec.pidsLimit }
          : {}),
        // Explicit per-port bindings (localhost-only) when requested; otherwise none.
        ...(ports.length ? { PortBindings: portBindings } : {}),
        // Belt-and-braces: never publish all exposed ports to the host (we bind explicitly above).
        PublishAllPorts: false,
      },
    });
    return { id: container.id, labels: spec.labels };
  }

  async startContainer(id: string): Promise<void> {
    await this.docker().getContainer(id).start();
  }

  async restartContainer(id: string): Promise<void> {
    // `docker restart` — stop + start the SAME container (writable layer, incl. the in-container git clone,
    // is preserved). Used by the boot-time daemon-version reconciliation; NEVER a remove+recreate (that
    // would destroy uncommitted/unpushed work in the clone).
    await this.docker().getContainer(id).restart();
  }

  async stopContainer(id: string): Promise<void> {
    try {
      await this.docker().getContainer(id).stop();
    } catch (err) {
      // Already-stopped (304) is not an error for our teardown intent.
      if (!isNotModified(err)) throw err;
    }
  }

  async removeContainer(id: string): Promise<void> {
    await this.docker().getContainer(id).remove({ force: true });
  }

  async listContainers(
    filter?: ListContainersFilter,
  ): Promise<ContainerSummary[]> {
    const infos = await this.docker().listContainers({
      all: filter?.all ?? false,
      ...(filter?.label ? { filters: { label: filter.label } } : {}),
    });
    return infos.map((info) => ({
      id: info.Id,
      names: info.Names ?? [],
      labels: info.Labels ?? {},
      state: info.State ?? '',
    }));
  }

  async inspectContainer(id: string): Promise<ContainerSummary | undefined> {
    try {
      const data = await this.docker().getContainer(id).inspect();
      return {
        id: data.Id,
        names: data.Name ? [data.Name] : [],
        labels: data.Config?.Labels ?? {},
        state: data.State?.Status ?? '',
      };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async createVolume(name: string, labels?: ContainerLabels): Promise<void> {
    // Idempotent: Docker's volume-create returns the existing volume when the name already exists.
    await this.docker().createVolume({ Name: name, Labels: labels ?? {} });
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.docker().getVolume(name).remove();
    } catch (err) {
      // A volume that's already gone is not an error for our teardown/sweep intent. A 409 (still in
      // use by a container) IS surfaced — the caller removes the container first.
      if (!isNotFound(err)) throw err;
    }
  }

  async listVolumes(filter?: ListVolumesFilter): Promise<VolumeSummary[]> {
    const res = await this.docker().listVolumes(
      filter?.label ? { filters: { label: filter.label } } : {},
    );
    // dockerode types `Volumes` as possibly-null; older daemons can omit it.
    return (res.Volumes ?? []).map((v) => ({
      name: v.Name,
      labels: v.Labels ?? {},
    }));
  }

  async inspectVolume(name: string): Promise<VolumeSummary | undefined> {
    try {
      const data = await this.docker().getVolume(name).inspect();
      return { name: data.Name, labels: data.Labels ?? {} };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async imagePresent(image: string): Promise<boolean> {
    try {
      await this.docker().getImage(image).inspect();
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async buildImage(spec: BuildImageSpec): Promise<void> {
    const docker = this.docker();
    // dockerode's documented `{ context, src }` form tars ONLY the listed files (the Dockerfile + what
    // it COPYs) — so we never tar the monorepo and need no direct `tar-fs` dependency.
    const stream = await docker.buildImage(
      { context: spec.contextDir, src: spec.src },
      {
        dockerfile: spec.dockerfile,
        t: spec.tag,
        ...(spec.pull ? { pull: true } : {}),
        ...(spec.noCache ? { nocache: true } : {}),
      },
    );
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err: Error | null, output: BuildProgress[]) => {
          if (err) return reject(err);
          // A failed Dockerfile step does NOT reject the stream — it arrives as an `error`/`errorDetail`
          // entry in the progress output, so scan for it explicitly.
          const failed = (output ?? []).find((o) => o.error || o.errorDetail);
          if (failed) {
            return reject(
              new Error(
                failed.error ??
                  failed.errorDetail?.message ??
                  'docker build failed',
              ),
            );
          }
          resolve();
        },
      );
    });
  }

  async runBuildContainer(spec: RunBuildContainerSpec): Promise<void> {
    const docker = this.docker();
    const container = await docker.createContainer({
      Image: spec.image,
      // Override the image ENTRYPOINT (the inner dockerd → daemon) so this run is purely the build.
      Entrypoint: ['bash', spec.innerScript],
      Cmd: [],
      // A TTY merges stdout+stderr into one clean (un-multiplexed) stream, so a failure's tail logs are
      // readable UTF-8 rather than docker's framed stream.
      Tty: true,
      HostConfig: {
        Binds: [
          `${spec.repoRoot}:/src:ro`,
          `${spec.buildVolume}:/build`,
          `${spec.storeVolume}:/pnpm-store`,
        ],
        AutoRemove: false,
      },
    });
    try {
      await container.start();
      const res = (await container.wait()) as { StatusCode?: number };
      if (res.StatusCode !== 0) {
        const logs = await container
          .logs({ follow: false, stdout: true, stderr: true, tail: 80 })
          .then((b) => b.toString('utf8'))
          .catch(() => '');
        throw new Error(
          `daemon build container exited ${res.StatusCode}\n${logs}`.trim(),
        );
      }
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  async daemonBuildPresent(
    volume: string,
    image: string,
    entryPath: string,
  ): Promise<boolean> {
    // Throwaway `test -f <entryPath>` against the build volume. Override the image ENTRYPOINT (which
    // would otherwise start the inner dockerd → daemon) so the container is purely the test command.
    const container = await this.docker().createContainer({
      Image: image,
      Entrypoint: ['test', '-f', entryPath],
      Cmd: [],
      HostConfig: { Binds: [`${volume}:/daemon:ro`], AutoRemove: false },
    });
    try {
      await container.start();
      const res = (await container.wait()) as { StatusCode?: number };
      return res.StatusCode === 0;
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  async readDaemonBuildVersion(
    volume: string,
    image: string,
    versionPath: string,
  ): Promise<string | undefined> {
    // Throwaway `cat <versionPath>` against the build volume (named-volume contents aren't host-readable
    // on Docker Desktop, so we read it from inside a container). Override the image ENTRYPOINT so the
    // container is purely the read. A TTY merges stdout into one un-multiplexed stream so the stamp is
    // clean UTF-8 (no docker frame headers). A non-zero exit (stamp absent — a build predating the
    // stamp) ⇒ undefined.
    const container = await this.docker().createContainer({
      Image: image,
      Entrypoint: ['cat', versionPath],
      Cmd: [],
      Tty: true,
      HostConfig: { Binds: [`${volume}:/daemon:ro`], AutoRemove: false },
    });
    try {
      await container.start();
      const res = (await container.wait()) as { StatusCode?: number };
      if (res.StatusCode !== 0) return undefined;
      const out = await container
        .logs({ follow: false, stdout: true, stderr: false })
        .then((b) => b.toString('utf8'))
        .catch(() => '');
      const stamp = out.trim();
      return stamp.length ? stamp : undefined;
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }
}

/** One entry in dockerode's build progress stream (`followProgress` output). Only the failure fields
 * matter to us — a failed Dockerfile step shows up here, not as a thrown error. */
interface BuildProgress {
  error?: string;
  errorDetail?: { message?: string };
}

/** dockerode surfaces HTTP statuses on the error — 404 = container gone. */
function isNotFound(err: unknown): boolean {
  return (err as { statusCode?: number })?.statusCode === 404;
}

/** 304 Not Modified = the container was already in the requested state (e.g. already stopped). */
function isNotModified(err: unknown): boolean {
  return (err as { statusCode?: number })?.statusCode === 304;
}
