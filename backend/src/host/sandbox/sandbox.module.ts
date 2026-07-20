import { CreateModule } from '@workspace/nestjs-core';
import { JobModule } from '../job/job.module';
import { WorkspaceProfileModule } from '../workspace-profile/workspace-profile.module';
import { SandboxRuntime } from './sandbox-runtime.service';

/**
 * The sandbox RUNTIME — a lazily materialized, resumable k8s pod that hosts the in-process engine for a job.
 * Not a user resource: no entity, no CRUD, no realtime table (k8s is the source of truth; see
 * {@link SandboxRuntime}). Imports `JobModule` (JobRepo → resolve a job's repo/org) and `WorkspaceProfileModule`
 * (the mounts/secrets/setup config it executes). K8s and Redis are global.
 */
@CreateModule({
  imports: [JobModule, WorkspaceProfileModule],
  services: [SandboxRuntime],
})
export class SandboxModule {}
