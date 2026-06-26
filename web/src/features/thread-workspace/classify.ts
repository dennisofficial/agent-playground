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
  | { kind: 'thinking'; message: ThreadMessage }
  | { kind: 'tool'; message: ThreadMessage }
  | { kind: 'approval'; message: ThreadMessage; card: WebApprovalCard }
  | { kind: 'verdict'; message: ThreadMessage; card: WebVerdictCard }
  | { kind: 'event'; message: ThreadMessage; tone: SystemTone };

const WARN_RE = /\b(paused|halt|failed|error|blocked|credential|expired)\b/i;
const OK_RE = /\b(resumed|done|completed|merged|approved|opened|landed)\b/i;

/**
 * Pick the bubble kind for a message — STRUCTURED SIGNALS ONLY. Everything is keyed off a real backend
 * field (`author`, `kind`, `card.type`); there is NO text-regex inference. Anything that isn't one of
 * those structured kinds falls through to plain `claude` prose (rendered as markdown). This deliberately
 * dropped the old park / PR / decision / status-line heuristics, which mis-fired on ordinary prose that
 * merely mentioned those words (e.g. a message discussing "always-ask" decisions rendered as a fake
 * "Decision needed — paused" card).
 */
export function classifyMessage(message: ThreadMessage): ClassifiedMessage {
  if (message.author === 'user' || message.local) {
    return { kind: 'user', message };
  }

  // Structured transcript blocks (from the in-sandbox session) — classified by `kind`, not by regex.
  if (message.kind === 'thinking') return { kind: 'thinking', message };
  if (message.kind === 'tool') return { kind: 'tool', message };

  if (message.card?.type === 'approval_card') {
    return { kind: 'approval', message, card: message.card };
  }
  if (message.card?.type === 'verdict_card') {
    return { kind: 'verdict', message, card: message.card };
  }

  // The driver's build relays are a real backend kind (`build_event`) — the only system-pill source.
  if (message.kind === 'build_event') {
    return { kind: 'event', message, tone: toneOf(message.text ?? '') };
  }

  return { kind: 'claude', message };
}

export function toneOf(text: string): SystemTone {
  if (WARN_RE.test(text)) return 'warn';
  if (OK_RE.test(text)) return 'ok';
  if (/\[tool\]/.test(text)) return 'neutral';
  return 'accent';
}
