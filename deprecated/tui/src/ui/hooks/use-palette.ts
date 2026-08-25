import { useSyncExternalStore } from "react";
import { paletteVersion, subscribePalette } from "../palette-store.js";

/**
 * Repaint the tree when a colour changes.
 *
 * Called ONCE, at the app root. Not per component: the palette is a mutable singleton, so every
 * component already reads the current colour the next time it renders — what none of them can do is
 * notice that they should. One subscription at the top makes the whole tree render again, which is
 * all that is missing. Sixty subscriptions would achieve exactly the same repaint sixty times over.
 *
 * The snapshot is a number rather than the palette itself, and that is load-bearing:
 * `useSyncExternalStore` compares snapshots by identity, and the palette object is mutated in place
 * — so it is `===` to itself before and after every edit and would never trigger anything. A
 * counter is the only thing here that actually changes identity when a colour does.
 */
export function usePaletteVersion(): number {
  return useSyncExternalStore(subscribePalette, paletteVersion);
}
