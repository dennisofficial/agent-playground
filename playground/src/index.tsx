import { render } from 'ink';
import { App } from './ui/App.js';
import { sessionDump } from './ui/transcript.js';
import { adoptWorkspaces } from './workspace.js';

// Re-adopt durable ticket worktrees from git (they survive restart even though the in-memory job
// registry doesn't) and sweep orphaned per-job worktrees. Fire-and-forget — no execute job can start
// until the user has chatted, planned, and approved.
void adoptWorkspaces();

// Run in the terminal's ALTERNATE screen buffer (like vim/htop): Ink owns enter + restore, which is what
// lets the input stay pinned and frees us from native-scrollback pollution. The startup banner is the
// first transcript item (App seeds it), so nothing writes to stdout before Ink mounts.
const interactive = process.stdout.isTTY;
const instance = render(<App />, { alternateScreen: interactive });

// The alternate screen has no scrollback, and Ink discards teardown-time output — so AFTER it exits (and
// restores the primary screen) we print the captured transcript (debug rows included) to normal scrollback,
// where it's copyable and pipeable.
void instance.waitUntilExit().then(() => {
  if (sessionDump.text) process.stdout.write(`${sessionDump.text}\n`);
});
