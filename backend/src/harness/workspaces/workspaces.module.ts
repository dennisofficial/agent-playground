import { CreateModule } from '@workspace/nestjs-core';
import { RedisModule } from '../../_lib/redis/redis.module';
import { EnginesModule } from '../engines/engines.module';
import { ProjectsModule } from '../projects/projects.module';
import { SkillsModule } from '../skills/skills.module';
import { CONTAINER_ENGINE } from './container-engine.port';
import { ContainerManagerService } from './container-manager.service';
import { CredentialProvisionerService } from './credential-provisioner.service';
import { DaemonClient } from './daemon-client';
import { DockerodeAdapter } from './dockerode.adapter';
import { LocalWorkspaceAdapter } from './local-workspace.adapter';
import { RemoteTurnDispatcher } from './remote-turn.dispatcher';
import { SandboxRegistry } from './sandbox-registry';
import { TurnExecutor } from './turn-executor.service';
import { WorkspaceGitProvider } from './workspace-git.provider';
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
 *
 * Phase 7 adds the unified turn-execution seam:
 *  - `TurnExecutor` — the single `engines.get().run()` fork (local host vs. remote sandbox), exported
 *    for the three engine consumers (SessionRunnerService, ReviewPipelineService, SelfReviewHandler);
 *  - `RemoteTurnDispatcher` — its dormant remote branch (resolves the sandbox + tool sources and
 *    dispatches over `DaemonClient`). It depends on `EngineRegistry` (EnginesModule) for the local
 *    fork and `AgentToolSourceResolver` (SkillsModule) for the remote tool-source resolve — both
 *    already in scope for SessionsModule, imported here so the seam composes inside this module.
 *
 * Phase 8 adds the GIT-routing sibling seam (the same fork, for async git ops instead of engine turns):
 *  - `WorkspaceGitProvider` — `resolve(ctx)` returns the `WorkspaceGitPort` a consumer runs its async
 *    git op against. Hard-false `isContainerized` this phase ⇒ ALWAYS the local adapter (behavior
 *    unchanged); the dormant daemon branch is built + unit-tested only. Exported for every consumer that
 *    used to call `WorkspaceService` for an async git method (session-runner, review-pipeline, the
 *    workspace/session/reference/pipeline/open-pr tools).
 *  - `LocalWorkspaceAdapter` — the pure 1:1 pass-through to `WorkspaceService` the provider returns
 *    locally. (`DaemonGitAdapter` is constructed per-sandbox inside the provider, not a DI provider.)
 */
@CreateModule({
  imports: [RedisModule, EnginesModule, ProjectsModule, SkillsModule],
  services: [
    WorkspaceService,
    DaemonClient,
    SandboxRegistry,
    ContainerManagerService,
    CredentialProvisionerService,
    RemoteTurnDispatcher,
    TurnExecutor,
    LocalWorkspaceAdapter,
    WorkspaceGitProvider,
  ],
  chains: [
    {
      provide: CONTAINER_ENGINE,
      useClass: DockerodeAdapter,
    },
  ],
})
export class WorkspacesModule {}
