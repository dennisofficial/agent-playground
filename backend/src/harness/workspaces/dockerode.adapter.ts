import { Injectable, Logger } from '@nestjs/common';
import Docker from 'dockerode';
import { EnvService } from '@core/config/env/env.service';
import type {
  ContainerEnginePort,
  ContainerHandle,
  ContainerSummary,
  CreateContainerSpec,
  ListContainersFilter,
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
      // No ExposedPorts / no PortBindings — sandboxes have NO inbound network / NO published ports.
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
        // Belt-and-braces: never publish all exposed ports to the host.
        PublishAllPorts: false,
      },
    });
    return { id: container.id, labels: spec.labels };
  }

  async startContainer(id: string): Promise<void> {
    await this.docker().getContainer(id).start();
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
}

/** dockerode surfaces HTTP statuses on the error — 404 = container gone. */
function isNotFound(err: unknown): boolean {
  return (err as { statusCode?: number })?.statusCode === 404;
}

/** 304 Not Modified = the container was already in the requested state (e.g. already stopped). */
function isNotModified(err: unknown): boolean {
  return (err as { statusCode?: number })?.statusCode === 304;
}
