import { EDelegateStatus } from './message.js';
import type { Delegate } from './delegates.js';

/**
 * What a delegate's row SAYS — the render half of `delegates.ts`, split off it for the same reason
 * `tool-view.ts` is split off `tool-summary.ts`: one decides what a thing is, this decides how it reads,
 * and they change for different reasons.
 *
 * Two lines at most, and the second only when the SDK has written a gist. The whole design constraint
 * is that this hangs under a tool block in a transcript somebody is reading for something else: a
 * delegate that takes four lines to say it is working has taken the screen from the work.
 */

/** `Explore agent`, `Agent` — the delegate's own name, never the spawning tool's. */
export function delegateName(delegate: Delegate): string {
  if (delegate.agentType === undefined) return 'Agent';
  const first = delegate.agentType.charAt(0).toUpperCase();
  return `${first}${delegate.agentType.slice(1)} agent`;
}

/**
 * The measure line: how much work, for how long, and what it is touching right now.
 *
 * `background` leads when it applies, because it changes what the reader should expect — a background
 * delegate's result is NOT the next thing that happens in this transcript, and a reader who misses that
 * reads the following blocks as its output.
 */
export function delegateMeasure(delegate: Delegate, now: number): string {
  const parts: string[] = [];
  if (delegate.background) parts.push('background');
  parts.push(plural(delegate.toolUses, 'tool'));
  parts.push(elapsed((delegate.endedAt ?? now) - delegate.startedAt));
  // Only while it is still going. After it settles the last tool is trivia, and the outcome — which
  // takes the same slot — is the thing worth the columns.
  if (delegate.status === EDelegateStatus.running && delegate.lastTool !== undefined)
    parts.push(delegate.lastTool);
  if (delegate.status === EDelegateStatus.failed) parts.push('failed');
  if (delegate.status === EDelegateStatus.stopped) parts.push('stopped');
  return parts.join(' · ');
}

/**
 * The gist, if the SDK wrote one — quoted, because they are its words about itself and not Atlas's
 * account of it. Dropped once the delegate settles: a present-tense "Analyzing the markdown layer" over
 * a finished run is a lie about the tense, and its real report is in the tool result just below.
 */
export function delegateGist(delegate: Delegate): string | undefined {
  if (delegate.status !== EDelegateStatus.running) return undefined;
  const gist = delegate.progress?.trim();
  if (!gist) return undefined;
  return `“${firstLine(gist)}”`;
}

/**
 * A background delegate as the panel under the composer draws it: what it is, and how long it has been
 * going. No tool count — the panel is a list of things you are WAITING on, and how busy each one has
 * been is a question you ask in the transcript, where the block that spawned it says so.
 */
export function delegateBadge(delegate: Delegate, now: number): string {
  const label = delegate.description.trim() || delegateName(delegate);
  return `${firstLine(label)} · ${elapsed(now - delegate.startedAt)}`;
}

/**
 * Its own, rather than the working line's `formatElapsed`, because that one lives in `ui/theme.ts` and
 * `domain/` imports nothing from `ui/`. The forms match on purpose — two clocks on one screen reading
 * `32s` and `0:32` is a difference the reader has to resolve for no reason.
 */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A description can be a whole prompt; a row gets its opening sentence and nothing else. */
function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}
