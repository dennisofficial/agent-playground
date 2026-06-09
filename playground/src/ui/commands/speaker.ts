import { conductor } from '../../conductor.js';
import type { Command } from './types.js';

/**
 * `/as <name>` — switch who you're speaking as in the channel (lets you simulate a group chat). Requires a
 * name (as before); `/as` alone falls through. The raw name is passed straight to `setSpeaker`, which does
 * its own normalization. No transcript note.
 */
export const asCommand: Command = {
  name: 'as',
  summary: '/as <name> — speak as someone else in the channel',
  run(text) {
    const m = text.match(/^\/as\s+(.+)$/i);
    if (!m) return false;
    conductor.setSpeaker(m[1]);
    return true;
  },
};
