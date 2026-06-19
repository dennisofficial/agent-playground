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
import { ReferenceLibraryService } from './reference-library.service';
import { RemoteTurnDispatcher } from './remote-turn.dispatcher';
import { SandboxReadinessService } from './sandbox-readiness.service';
import { SandboxRegistry } from './sandbox-registry';
import { TurnExecutor } from './turn-executor.service';
import { WorkspaceGitProvider } from './workspace-git.provider';
import { WorkspaceProvisionerService } from './workspace-provisioner.service';
import { WorkspaceReader } from './workspace-reader';
import { WorkspaceRegistry } from './workspace-registry';

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
 *  - `WorkspaceProvisionerService` — self-provisions the base image + mounted daemon build AT BOOT
 *    (via the same `CONTAINER_ENGINE` seam), so a deploy no longer needs a manual `pnpm daemon:build`.
 *    `ContainerManagerService.create` awaits its memoized `ensureProvisioned()` before spawning.
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
 *    git op against. Daemon-only now (the host `WorkspaceService`/`LocalWorkspaceAdapter` path was
 *    deleted): it ALWAYS returns the in-sandbox `DaemonGitAdapter`, constructed per-sandbox inside the
 *    provider (not a DI provider), and THROWS when the ctx's work area has no live sandbox. Exported for
 *    every consumer of an async git method (session-runner, review-pipeline, the workspace/session/
 *    reference/pipeline/open-pr tools). `resolveReferenceTarget(ctx)` is the reference-clone variant —
 *    it resolves a live workstation to clone into and returns undefined (no throw) when none exists.
 *
 * Phase 10 (host half) adds the READINESS GATE — `SandboxReadinessService`. The in-sandbox daemon XADDs
 * a durable `ws:{id}:ready` marker once inner Docker + its consumer loop are up; this service blocks the
 * FIRST remote turn (`RemoteTurnDispatcher`) on that marker so a `docker compose` turn never races a
 * not-yet-ready daemon. It consumes the same `REDIS_STREAM_PORT` seam; the manager clears its cache on
 * `destroyWorkspace`.
 */
@CreateModule({
  imports: [RedisModule, EnginesModule, ProjectsModule, SkillsModule],
  services: [
    DaemonClient,
    SandboxRegistry,
    SandboxReadinessService,
    WorkspaceProvisionerService,
    ContainerManagerService,
    CredentialProvisionerService,
    RemoteTurnDispatcher,
    TurnExecutor,
    WorkspaceGitProvider,
    WorkspaceRegistry,
    WorkspaceReader,
    ReferenceLibraryService,
  ],
  chains: [
    {
      provide: CONTAINER_ENGINE,
      useClass: DockerodeAdapter,
    },
  ],
})
export class WorkspacesModule {}
