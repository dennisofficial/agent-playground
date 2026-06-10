import { CreateModule } from '@workspace/nestjs-core';
import { WorktreeService } from './worktree.service';

/**
 * Employee-managed git worktrees — the isolated work areas sessions run in. In-memory registry over
 * git (the durable store: checkouts/branches survive restarts and are re-adopted on boot).
 */
@CreateModule({
  services: [WorktreeService],
})
export class WorktreesModule {}
