import { render } from 'ink';
import { ROSTER } from './employees/index.js';
import { App } from './ui/App.js';

// Clear the screen (and scrollback) on startup for a fresh canvas, like Claude Code.
// Guarded on TTY so piped/redirected output isn't polluted with escape codes.
if (process.stdout.isTTY) {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

const team = ROSTER.map((b) => `${b.name} (${b.role})`).join(' · ');
console.log(
  `#dev — ${team}\n/as <name> to speak as someone   ·   @Name to address a bot   ·   /exit\n`,
);
render(<App />);
