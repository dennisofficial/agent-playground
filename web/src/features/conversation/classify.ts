import type { WebApprovalCard, WebOutboundMessage, WebVerdictCard } from '@/lib/api/types';

/**
 * The conversation bubble kinds the work column renders. `approval`/`verdict` are STRUCTURED (the card
 * payload); the rest are inferred from the text the brain emits, with a plain `claude` fallback.
 * Robust typing needs structured message metadata from the backend (BACKEND_GAPS.md #11).
 */
export type SystemTone = 'ok' | 'warn' | 'accent' | 'neutral';

export type ClassifiedMessage =
  | { kind: 'user'; message: WebOutboundMessage }
  | { kind: 'claude'; message: WebOutboundMessage }
  | { kind: 'approval'; message: WebOutboundMessage; card: WebApprovalCard }
  | { kind: 'verdict'; message: WebOutboundMessage; card: WebVerdictCard }
  | { kind: 'decision'; message: WebOutboundMessage }
  | { kind: 'park'; message: WebOutboundMessage }
  | { kind: 'pr'; message: WebOutboundMessage }
  | { kind: 'event'; message: WebOutboundMessage; tone: SystemTone };

const PARK_RE = /decision needed|paused\b.*\bdecision|reply below to answer|always-ask/i;
const DECISION_RE = /^\s*(🔒|decision[:—-]|locked decision|decision record)/i;
const PR_RE = /pull request|ready for review|github\.com\/[^\s]+\/pull\/|\bPR #?\d+\b/i;
const WARN_RE = /\b(paused|halt|failed|error|blocked|credential)\b/i;
const OK_RE = /\b(resumed|done|completed|merged|approved|opened)\b/i;

/** Pick the bubble kind for a message. */
export function classifyMessage(message: WebOutboundMessage): ClassifiedMessage {
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
  const isBuildEvent = (message.meta as { kind?: string } | undefined)?.kind === 'build_event';

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

function toneOf(text: string): SystemTone {
  if (WARN_RE.test(text)) return 'warn';
  if (OK_RE.test(text)) return 'ok';
  if (/\[tool\]/.test(text)) return 'neutral';
  return 'accent';
}
