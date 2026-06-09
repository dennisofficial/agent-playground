import type { Reaction, RenderItem } from './messages.js';

/**
 * The keyed transcript store. `items` is the full ordered list; the first `settledCount` are FROZEN into the
 * Ink `<Static>` prefix (flushed to the terminal's native scrollback, never re-rendered), and the rest are
 * the live tail rendered dynamically so they can still be PATCHED in place (a reaction folding into its
 * message). The settled boundary only ever advances — Ink has already drawn those rows — and it advances
 * eagerly by RENDERED SIZE (not item count, and not on idle: this repo's bot cascades can run unbounded), so
 * the dynamic region stays ≈ one screen and never overflows Ink's repaint.
 */
export interface ItemStore {
  items: RenderItem[];
  settledCount: number;
}

/** Terminal size, used only to bound the live region. */
export interface Viewport {
  rows: number;
  cols: number;
}

export type StoreAction =
  | { t: 'add'; item: RenderItem; vp: Viewport }
  // Fold a reaction onto its target message (by id) if that message is still live; otherwise the target has
  // scrolled into the Static prefix and can't be repainted → add a standalone reaction row (pre-store behavior).
  | { t: 'react'; id: string; targetId: string; by: string; emoji: string; vp: Viewport };

export const initStore = (items: RenderItem[] = []): ItemStore => ({ items, settledCount: 0 });

/** Approximate rendered terminal rows for an item — width-aware so one very long line can't blow the budget. */
export function estimateRows(item: RenderItem, cols: number): number {
  const w = Math.max(1, cols);
  const textRows = (s: string): number =>
    s.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / w)), 0);
  switch (item.kind) {
    case 'user':
      return 1 + textRows(item.text) + (item.reactions?.length ? 1 : 0) + 1; // header + body + reactions + margin
    case 'assistant':
      return 1 + textRows(item.text) + (item.usage ? 1 : 0) + (item.reactions?.length ? 1 : 0) + 1;
    case 'recall':
      return 1 + textRows(item.text);
    case 'note':
      return textRows(item.text) + 2; // marginY: 1 top + 1 bottom
    case 'approval':
      return 1 + 2; // marginY
    case 'error':
      return 1 + 1; // marginBottom
    case 'gate':
      return textRows(item.reasoning);
    case 'tool':
    case 'reaction':
    case 'worker':
    case 'memory':
    case 'reminders':
    case 'workspace':
      return 1;
  }
}

/** Advance the settled boundary until the live tail (items after it) fits within `vp.rows`. Monotonic. */
function freezeToFit(items: RenderItem[], settledCount: number, vp: Viewport): number {
  let used = 0;
  let firstLive = items.length; // nothing fits → settle everything (a single huge item flushes to scrollback)
  for (let i = items.length - 1; i >= settledCount; i--) {
    used += estimateRows(items[i], vp.cols);
    if (used > vp.rows) break;
    firstLive = i;
  }
  return Math.max(settledCount, firstLive);
}

export function storeReducer(state: ItemStore, action: StoreAction): ItemStore {
  switch (action.t) {
    case 'add': {
      const items = [...state.items, action.item];
      return { items, settledCount: freezeToFit(items, state.settledCount, action.vp) };
    }
    case 'react': {
      const idx = state.items.findIndex(
        (it, i) =>
          i >= state.settledCount &&
          it.id === action.targetId &&
          (it.kind === 'user' || it.kind === 'assistant'),
      );
      const target = idx === -1 ? undefined : state.items[idx];
      if (!target || (target.kind !== 'user' && target.kind !== 'assistant')) {
        // Target already settled (or unknown) → standalone reaction row, keyed by the reaction's own id.
        const fallback: RenderItem = {
          id: action.id,
          kind: 'reaction',
          by: action.by,
          emoji: action.emoji,
        };
        const items = [...state.items, fallback];
        return { items, settledCount: freezeToFit(items, state.settledCount, action.vp) };
      }
      const reaction: Reaction = { by: action.by, emoji: action.emoji };
      const items = state.items.slice();
      items[idx] = { ...target, reactions: [...(target.reactions ?? []), reaction] };
      // The fold added a row to a live item — re-tighten so the tail still fits.
      return { items, settledCount: freezeToFit(items, state.settledCount, action.vp) };
    }
  }
}
