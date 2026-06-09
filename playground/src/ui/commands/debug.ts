import type { Command } from './types.js';

/**
 * `/debug` — toggle operator-facing debug rows (gate reasoning, memory/reminder deltas, tool calls, worker
 * notes). Default off = a "pure Slack" view. `/debug on` / `/debug off` set it explicitly. Hidden rows stay
 * logged in state, so you can flip them on to see what happened, then hide them again.
 */
export const debugCommand: Command = {
  name: 'debug',
  summary: '/debug [on|off] — show/hide debug logs (gate, memory, tools)',
  run(text, ctx) {
    const m = text.match(/^\/debug(?:\s+(on|off))?$/i);
    if (!m) return false;
    const want = m[1] ? m[1].toLowerCase() === 'on' : undefined; // undefined → toggle
    const shown = ctx.setDebug(want);
    ctx.note(shown ? 'Debug logs shown.' : 'Debug logs hidden.');
    return true;
  },
};
