import { CreateModule } from '@workspace/nestjs-core';
import { ProjectsModule } from '../projects/projects.module';
import { WorktreeService } from './worktree.service';

/**
 * Employee-managed git worktrees — the isolated work areas sessions run in. In-memory registry over
 * git (the durable store: checkouts/branches survive restarts and are re-adopted on boot).
 * Per-project: registered projects (ProjectsModule) get their GitHub repo cloned on first use;
 * unregistered projects cut from WORKER_ROOT.
 */
@CreateModule({
  imports: [ProjectsModule],
  services: [WorktreeService],
})
export class WorktreesModule {}
