import { agentMessage, type AgentMessage } from '../../../_shared/prompt-kit/message';


export function renderCommitTurnTask(): AgentMessage {
  return agentMessage(
    `You have UNCOMMITTED changes in the working tree, but the thread is otherwise finished. Commit them` +
      ` now: run \`git add -A\` (your \`.gitignore\` governs what's tracked — if build/cache junk appears,` +
      ` add it to \`.gitignore\` instead of committing it), commit with a clear message, and \`git push\`` +
      ` your branch. Leave the tree CLEAN, then stop. Do nothing else.`,
  );
}
