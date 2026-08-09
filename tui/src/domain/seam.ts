import type { ESessionEndReason } from '../generated/prisma/enums.js';
import type { Message } from './message.js';

/**
 * The rotation seam is DERIVED, never stored: a seam is simply the place where two adjacent messages
 * disagree about which session produced them, so there is no event row to keep in sync with reality.
 */

export type SessionRef = {
  id: string;
  ordinal: number;
  endReason: ESessionEndReason | null;
};

export type Seam = {
  kind: 'seam';
  /** The session being entered. */
  sessionId: string;
  ordinal: number;
  /** Why the PREVIOUS session ended — that is what the divider is explaining. */
  endReason: ESessionEndReason | null;
};

export type TranscriptItem = { kind: 'message'; message: Message } | Seam;

/**
 * Only session CHANGE draws a seam, so the first session never does — you did not rotate into it.
 * Account rotation deliberately draws nothing: it does not change the session, and a seam would
 * imply a discontinuity that is not there.
 */
export function withSeams(messages: Message[], sessions: SessionRef[]): TranscriptItem[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const items: TranscriptItem[] = [];
  let previousSessionId: string | undefined;

  for (const message of messages) {
    if (previousSessionId !== undefined && message.sessionId !== previousSessionId) {
      const entered = byId.get(message.sessionId);
      const left = byId.get(previousSessionId);
      items.push({
        kind: 'seam',
        sessionId: message.sessionId,
        ordinal: entered?.ordinal ?? 0,
        endReason: left?.endReason ?? null,
      });
    }
    items.push({ kind: 'message', message });
    previousSessionId = message.sessionId;
  }
  return items;
}

/** 1 means "no rotation yet". */
export function currentSessionOrdinal(messages: Message[], sessions: SessionRef[]): number {
  const last = messages.at(-1);
  if (!last) return sessions.at(-1)?.ordinal ?? 1;
  return sessions.find((s) => s.id === last.sessionId)?.ordinal ?? 1;
}
