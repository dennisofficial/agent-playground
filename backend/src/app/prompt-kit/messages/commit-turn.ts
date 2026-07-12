import { agentMessage, type AgentMessage } from '../message';

/**
 * prompt-kit / messages / commit-turn — the COMMIT-NUDGE turn resumed on a writer's own session when its
 * thread is otherwise finished but the worktree still has uncommitted changes (see `ThreadDriver.kickCommitTurn`).
 */

/** The commit-nudge task: commit + push whatever is left uncommitted, then stop. */
export function renderCommitTurnTask(): AgentMessage {
  return agentMessage(
    `You have UNCOMMITTED changes in the working tree, but the thread is otherwise finished. Commit them` +
      ` now: run \`git add -A\` (your \`.gitignore\` governs what's tracked — if build/cache junk appears,` +
      ` add it to \`.gitignore\` instead of committing it), commit with a clear message, and \`git push\`` +
      ` your branch. Leave the tree CLEAN, then stop. Do nothing else.`,
  );
}
