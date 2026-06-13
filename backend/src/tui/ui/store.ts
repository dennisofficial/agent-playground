import type { RenderItem } from './messages';

/**
 * The transcript store: a flat, ordered, keyed list of items. The full-screen renderer keeps EVERY item in
 * state (it owns the screen and scrolls/filters a window of them — see App.tsx), so unlike the old
 * `<Static>` model nothing is ever frozen or dropped. That also means a reaction can always fold onto its
 * target message, however far back it is.
 */
export type StoreAction =
  | { t: 'add'; item: RenderItem }
  // Fold a reaction onto its target message by id; if the id isn't found, append a standalone reaction row.
  | { t: 'react'; id: string; targetId: string; by: string; emoji: string }
  // Un-fold a reaction (same {by, emoji}) from its target message; also drops a standalone row if that's where it landed.
  | { t: 'unreact'; targetId: string; by: string; emoji: string };

export function storeReducer(
  items: RenderItem[],
  action: StoreAction,
): RenderItem[] {
  switch (action.t) {
    case 'add':
      return [...items, action.item];
    case 'react': {
      const idx = items.findIndex(
        (it) =>
          it.id === action.targetId &&
          (it.kind === 'user' || it.kind === 'assistant'),
      );
      const target = idx === -1 ? undefined : items[idx];
      if (!target || (target.kind !== 'user' && target.kind !== 'assistant')) {
        return [
          ...items,
          {
            id: action.id,
            kind: 'reaction',
            by: action.by,
            emoji: action.emoji,
          },
        ];
      }
      const next = items.slice();
      next[idx] = {
        ...target,
        reactions: [
          ...(target.reactions ?? []),
          { by: action.by, emoji: action.emoji },
        ],
      };
      return next;
    }
    case 'unreact': {
      const matches = (by: string, emoji: string): boolean =>
        by === action.by && emoji === action.emoji;
      return (
        items
          // Drop a standalone reaction row that matches (the not-found fallback from 'react').
          .filter((it) => !(it.kind === 'reaction' && matches(it.by, it.emoji)))
          // Un-fold the matching reaction from its target message (removes the FIRST match only).
          .map((it) => {
            if (
              (it.kind !== 'user' && it.kind !== 'assistant') ||
              it.id !== action.targetId ||
              !it.reactions?.length
            )
              return it;
            const at = it.reactions.findIndex((r) => matches(r.by, r.emoji));
            if (at === -1) return it;
            const reactions = it.reactions.slice();
            reactions.splice(at, 1);
            return { ...it, reactions };
          })
      );
    }
  }
}
