import { render } from 'ink';
import { BOT } from './persona.js';
import { App } from './ui/App.js';

// Clear the screen (and scrollback) on startup for a fresh canvas, like Claude Code.
// Guarded on TTY so piped/redirected output isn't polluted with escape codes.
if (process.stdout.isTTY) {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

console.log(
  `#dev — ${BOT.name} (${BOT.role})   ·   /as <name> to speak as someone else   ·   /exit to quit\n`,
);
render(<App />);
