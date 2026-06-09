import type { RenderItem } from './messages.js';

/**
 * The transcript store: a flat, ordered, keyed list of items. The full-screen renderer keeps EVERY item in
 * state (it owns the screen and scrolls/filters a window of them — see App.tsx), so unlike the old
 * `<Static>` model nothing is ever frozen or dropped. That also means a reaction can always fold onto its
 * target message, however far back it is.
 */
export type StoreAction =
  | { t: 'add'; item: RenderItem }
  // Fold a reaction onto its target message by id; if the id isn't found, append a standalone reaction row.
  | { t: 'react'; id: string; targetId: string; by: string; emoji: string };

export function storeReducer(items: RenderItem[], action: StoreAction): RenderItem[] {
  switch (action.t) {
    case 'add':
      return [...items, action.item];
    case 'react': {
      const idx = items.findIndex(
        (it) => it.id === action.targetId && (it.kind === 'user' || it.kind === 'assistant'),
      );
      const target = idx === -1 ? undefined : items[idx];
      if (!target || (target.kind !== 'user' && target.kind !== 'assistant')) {
        return [...items, { id: action.id, kind: 'reaction', by: action.by, emoji: action.emoji }];
      }
      const next = items.slice();
      next[idx] = {
        ...target,
        reactions: [...(target.reactions ?? []), { by: action.by, emoji: action.emoji }],
      };
      return next;
    }
  }
}
