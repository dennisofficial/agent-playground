import { ESessionEndReason } from '../generated/prisma/enums.js';
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

/**
 * What the divider says, and it is about the leg that ENDED, not the one starting.
 *
 * A rule that only counted legs would leave the reader with the one question a seam raises — why is
 * there a break here — answered nowhere, and the three answers are not interchangeable: an agent
 * that chose to hand over, an agent that ran out of room before it could, and a session ended by
 * hand are three different situations to be scrolling past.
 */
export function seamLabel(seam: {
  ordinal: number;
  endReason: ESessionEndReason | null;
}): string {
  // Ordinal 0 means the session refs were read before this leg existed — an agent rotated while the
  // page was open. The break is real either way, so it is drawn honestly rather than as "session 0".
  const leg = seam.ordinal > 0 ? `session ${seam.ordinal}` : 'new session';
  return `${leg} · ${endedBecause(seam.endReason)}`;
}

function endedBecause(endReason: ESessionEndReason | null): string {
  if (endReason === ESessionEndReason.context_pressure) return 'previous leg handed over';
  // The one forced rotation, and worth naming: this leg opened without a hand-off written for it.
  if (endReason === ESessionEndReason.context_wall) return 'previous leg hit the context wall';
  if (endReason === ESessionEndReason.manual) return 'previous leg was ended by hand';
  if (endReason === ESessionEndReason.engine_error) return 'previous leg died in the engine';
  if (endReason === ESessionEndReason.usage_limit) return 'previous leg hit a usage limit';
  if (endReason === ESessionEndReason.thread_closed) return 'previous leg closed with its thread';
  return 'previous leg ended';
}

/** 1 means "no rotation yet". */
export function currentSessionOrdinal(messages: Message[], sessions: SessionRef[]): number {
  const last = messages.at(-1);
  if (!last) return sessions.at(-1)?.ordinal ?? 1;
  return sessions.find((s) => s.id === last.sessionId)?.ordinal ?? 1;
}
