import type { WebApprovalCard, WebVerdictCard } from '@/lib/api/types';
import type { ThreadMessage } from '@/lib/api/thread-api';

/**
 * The conversation bubble kinds the work column renders. `approval`/`verdict` are STRUCTURED (the card
 * payload on the message); the rest are inferred from the text the brain emits, with a plain `claude`
 * fallback. (Robust typing would need richer message metadata from the backend — see BACKEND_GAPS.md.)
 */
export type SystemTone = 'ok' | 'warn' | 'accent' | 'neutral';

export type ClassifiedMessage =
  | { kind: 'user'; message: ThreadMessage }
  | { kind: 'claude'; message: ThreadMessage }
  | { kind: 'approval'; message: ThreadMessage; card: WebApprovalCard }
  | { kind: 'verdict'; message: ThreadMessage; card: WebVerdictCard }
  | { kind: 'decision'; message: ThreadMessage }
  | { kind: 'park'; message: ThreadMessage }
  | { kind: 'pr'; message: ThreadMessage }
  | { kind: 'event'; message: ThreadMessage; tone: SystemTone };

const PARK_RE = /decision needed|paused\b.*\bdecision|reply below to answer|always-ask|parked? (it|one)/i;
const DECISION_RE = /^\s*(🔒|decision[:—-]|locked decision|decision record)/i;
const PR_RE = /pull request|ready for review|github\.com\/[^\s]+\/pull\/|\bPR #?\d+\b/i;
const WARN_RE = /\b(paused|halt|failed|error|blocked|credential|expired)\b/i;
const OK_RE = /\b(resumed|done|completed|merged|approved|opened|landed)\b/i;

/** Pick the bubble kind for a message. */
export function classifyMessage(message: ThreadMessage): ClassifiedMessage {
  if (message.author === 'user' || message.local) {
    return { kind: 'user', message };
  }

  if (message.card?.type === 'approval_card') {
    return { kind: 'approval', message, card: message.card };
  }
  if (message.card?.type === 'verdict_card') {
    return { kind: 'verdict', message, card: message.card };
  }

  const text = message.text ?? '';
  const isBuildEvent = message.kind === 'build_event';

  if (PARK_RE.test(text)) return { kind: 'park', message };
  if (PR_RE.test(text)) return { kind: 'pr', message };
  if (DECISION_RE.test(text)) return { kind: 'decision', message };

  if (isBuildEvent || isShortStatusLine(text)) {
    return { kind: 'event', message, tone: toneOf(text) };
  }

  return { kind: 'claude', message };
}

/** Heuristic: terse one-liners (tool/status relays) read as system-event pills, not chat bubbles. */
function isShortStatusLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 140) return false;
  if (trimmed.startsWith('[tool]')) return true;
  return !trimmed.includes('\n') && (WARN_RE.test(trimmed) || OK_RE.test(trimmed));
}

export function toneOf(text: string): SystemTone {
  if (WARN_RE.test(text)) return 'warn';
  if (OK_RE.test(text)) return 'ok';
  if (/\[tool\]/.test(text)) return 'neutral';
  return 'accent';
}
