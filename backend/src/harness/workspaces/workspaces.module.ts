import { CreateModule } from '@workspace/nestjs-core';
import { RedisModule } from '../../_lib/redis/redis.module';
import { ProjectsModule } from '../projects/projects.module';
import { DaemonClient } from './daemon-client';
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
 */
@CreateModule({
  imports: [RedisModule, ProjectsModule],
  services: [WorkspaceService, DaemonClient],
})
export class WorkspacesModule {}
