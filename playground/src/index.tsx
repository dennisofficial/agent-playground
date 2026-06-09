import { render } from 'ink';
import { ROSTER } from './employees/index.js';
import { App } from './ui/App.js';
import { adoptWorkspaces } from './workspace.js';

// Clear the screen (and scrollback) on startup for a fresh canvas, like Claude Code.
// Guarded on TTY so piped/redirected output isn't polluted with escape codes.
if (process.stdout.isTTY) {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

// Re-adopt durable ticket worktrees from git (they survive restart even though the in-memory job
// registry doesn't) and sweep orphaned per-job worktrees. Fire-and-forget — no execute job can start
// until the user has chatted, planned, and approved.
void adoptWorkspaces();

const team = ROSTER.map((b) => `${b.name} (${b.role})`).join(' · ');
console.log(
  `#dev — ${team}\n/as <name> to speak as someone   ·   @Name to address a bot   ·   /exit\n`,
);
render(<App />);
