import { CreateModule } from '@workspace/nestjs-core';
import { RedisModule } from '../../_lib/redis/redis.module';
import { ProjectsModule } from '../projects/projects.module';
import { CONTAINER_ENGINE } from './container-engine.port';
import { ContainerManagerService } from './container-manager.service';
import { CredentialProvisionerService } from './credential-provisioner.service';
import { DaemonClient } from './daemon-client';
import { DockerodeAdapter } from './dockerode.adapter';
import { SandboxRegistry } from './sandbox-registry';
import { WorkspaceService } from './workspace.service';

/**
 * Employee-managed git workspaces — the isolated work areas sessions run in. In-memory registry over
 * git (the durable store: checkouts/branches survive restarts and are re-adopted on boot).
 * Per-project: registered projects (ProjectsModule) get their GitHub repo cloned on first use;
 * unregistered projects cut from WORKER_ROOT.
 *
 * Phase 5 also hosts the `DaemonClient` — the host's Redis client to in-sandbox daemons (driving
 * remote turns + git RPCs). It imports the shared `@Global` `RedisModule` so the `REDIS_STREAM_PORT`
 * the client injects is composed (the harness's single composition point for the Redis client); the
 * Phase-7 `RemoteTurnDispatcher` + Phase-8 `DaemonGitAdapter` consume the exported `DaemonClient`.
 *
 * Phase 6 adds the host SANDBOX LIFECYCLE — the home of all "workspace" management:
 *  - `CONTAINER_ENGINE` (the dockerode socket seam) bound to `DockerodeAdapter` in prod;
 *  - `ContainerManagerService` — spawns + reconciles per-workspace sandbox containers (the only socket
 *    consumer; `OnApplicationBootstrap` reconciles the registry from Docker labels);
 *  - `SandboxRegistry` — the in-memory `workspaceId ↔ record` map (`resolveForSession` lazily ensures);
 *  - `CredentialProvisionerService` — the host side of the just-in-time GitHub cred-pull channel.
 * Nothing CALLS `ensureWorkspace` yet (Phase 9 wires session lifecycle); the registered ensurer is
 * consumed by Phase 7's `RemoteTurnDispatcher`.
 */
@CreateModule({
  imports: [RedisModule, ProjectsModule],
  services: [
    WorkspaceService,
    DaemonClient,
    SandboxRegistry,
    ContainerManagerService,
    CredentialProvisionerService,
  ],
  chains: [
    {
      provide: CONTAINER_ENGINE,
      useClass: DockerodeAdapter,
    },
  ],
})
export class WorkspacesModule {}
