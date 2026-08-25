import type { ToolContext } from '../tools/tool.js';
import type { WorktreeService } from '../worktree.service.js';

export type TakeWorktreeCall = { ctx: ToolContext };

/**
 * A seam fixture's tenth constructor argument, held for the same reason as the ninth: the registry
 * offers `enter_worktree` only when `ToolActions.worktree` is there, so a fixture that stopped
 * passing one would make the tool vanish from every seam test without failing any of them.
 *
 * Cast rather than implemented — the real service reaches for `git` and the filesystem, and a fake
 * that satisfied the whole class would be a second implementation of it.
 */
export function fakeWorktreeService(calls: TakeWorktreeCall[] = []): WorktreeService {
  return {
    async take(args: TakeWorktreeCall): Promise<string> {
      calls.push(args);
      return 'worktree taken';
    },
  } as unknown as WorktreeService;
}
