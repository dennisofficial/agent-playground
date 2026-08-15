import { type Palette, SHIPPED_PALETTE, theme } from "./palette.js";

/**
 * How a colour change reaches the screen.
 *
 * The palette is a mutable singleton (see `palette.ts`), so a new colour is visible to every reader
 * the instant it is written. What a mutation cannot do by itself is make React draw again — so one
 * `useSyncExternalStore` at the app root watches the version below, and a bump repaints the tree.
 * Same shape as `JobTitleService`: subscribe, read a value, no Context cascade.
 *
 * The version is a NUMBER on purpose. `useSyncExternalStore` re-renders on identity, so a snapshot
 * that built a fresh object per call would loop forever — and it would not look like a loop. See
 * the note on `turn-lanes.ts`'s `announce()` for the same trap caught in the running-threads store.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Caches that captured a colour when they were BUILT and cannot re-read it.
 *
 * A re-render fixes the ~55 sites that read `theme.x` inside a render or a function body. It does
 * nothing for a module-scope table, a `SyntaxStyle` handed to the Zig renderer, or a per-filetype
 * memo — those hold a copy of a colour that no longer exists anywhere else. Each such site
 * registers a callback here and throws its copy away when the palette moves.
 */
const invalidators = new Set<() => void>();

let version = 0;

/**
 * Register a cache to be dropped on every palette change.
 *
 * No unregister, deliberately: every caller is a module-scope cache that lives as long as the
 * process, so a remove would be an API nobody could correctly call.
 */
export function onPaletteChange(invalidate: () => void): void {
  invalidators.add(invalidate);
}

/** Arrow-bound so `useSyncExternalStore` gets a stable identity and does not resubscribe per render. */
export const subscribePalette = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The snapshot. A counter, not a palette — see the identity note above. */
export const paletteVersion = (): number => version;

/**
 * Write colours into the live palette and tell everything that cares.
 *
 * Partial, so a caller can move one token without restating the other twenty. A nested group is
 * replaced wholesale rather than merged — passing `court` means passing all four courts, because a
 * half-specified court would leave two hues from the old theme and two from the new.
 */
export function applyPalette(next: Partial<Palette>): void {
  Object.assign(theme, next);
  version += 1;

  // Caches first, renderers second, and the order is the correctness argument rather than a
  // preference: a React re-render that ran before the caches were dropped would repaint FROM those
  // caches, so the frame after an edit would still show the old colour and the frame after that the
  // new one. That reads as a laggy editor, which is exactly the failure a live preview exists to
  // avoid.
  for (const invalidate of invalidators) invalidate();
  for (const listener of listeners) listener();
}

/** Back to the shipped colours. Cloned on the way in, or the next edit would write into the defaults. */
export function resetPalette(): void {
  applyPalette(structuredClone(SHIPPED_PALETTE));
}
