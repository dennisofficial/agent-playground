'use client';
import type { LiveTurn } from '@/lib/api/job-stream';
import { buildLiveTurnItems } from './bubbles';

export function LiveTurnView({
  turn,
  lane,
  onSelectNode,
}: {
  turn: LiveTurn;
  /** The lane `turn` is streaming on — baked into any subagent card's node so its pane subscribes to the
   *  right live turn (see {@link subagentNode}). */
  lane: string;
  onSelectNode?: (node: string) => void;
}) {
  return (
    <>
      {buildLiveTurnItems(turn, lane, onSelectNode).map((it) => (
        <div key={it.key}>{it.node}</div>
      ))}
    </>
  );
}
