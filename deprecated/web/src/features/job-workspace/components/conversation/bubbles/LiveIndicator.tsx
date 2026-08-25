'use client';
import {
  formatElapsed,
  type LiveTurn,
  summarizeLiveTurn,
  useElapsedSeconds,
} from '@/lib/api/job-stream';
import { useRetryCountdown } from './bubbles';

export function LiveIndicator({
  turn,
  text = 'Atlas is working…',
}: {
  turn?: LiveTurn;
  text?: string;
}) {
  const elapsed = useElapsedSeconds(turn?.startedAt);
  const { openTools, statusWord } = summarizeLiveTurn(turn);
  // Hook called UNCONDITIONALLY (rules of hooks); returns null when no retry is in flight.
  const retrySecs = useRetryCountdown(turn?.retrying?.nextAttemptAt);
  const retrying = turn?.retrying;
  const label = retrying
    ? `Reconnecting to Claude — auto-retry ${retrying.attempt}/${retrying.max}${retrySecs != null ? ` · retrying in ${retrySecs}s` : '…'}`
    : !turn
      ? text
      : [
          formatElapsed(elapsed),
          openTools > 0 ? `${openTools} running task${openTools === 1 ? '' : 's'}` : null,
          `${statusWord}…`,
        ]
          .filter(Boolean)
          .join(' · ');
  return (
    <div className="anim-fadeUp flex items-center gap-2.5 text-[11.5px] text-accent">
      <span
        className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          background: 'var(--accent)',
          boxShadow: '0 0 9px var(--accent)',
        }}
      />
      <span className="tabular-nums">{label}</span>
    </div>
  );
}
