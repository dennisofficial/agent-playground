import { render } from 'ink';
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

// The startup banner is now the first transcript item (App seeds it), so nothing writes to stdout before
// Ink mounts — everything goes through the interface.
render(<App />);
