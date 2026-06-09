import type { Command } from './types.js';

/** `/exit` or `/quit` — leave the app. Exact lowercase match (as before); anything trailing falls through. */
export const exitCommand: Command = {
  name: 'exit',
  summary: '/exit (or /quit) — leave the app',
  run(text, ctx) {
    if (text !== '/exit' && text !== '/quit') return false;
    ctx.exit();
    return true;
  },
};
