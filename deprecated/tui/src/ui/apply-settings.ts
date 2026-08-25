import type { Settings } from "../domain/settings.js";
import { setCodeTheme } from "./markdown/themes/index.js";
import { applyPalette, resetPalette } from "./palette-store.js";

/**
 * A `Settings` value to the colours on screen.
 *
 * The half of settings that `app/` is not allowed to do — it may not import `ui/` — and the half
 * that has to happen before the first frame, or the app paints in its shipped colours and then
 * corrects itself a moment later.
 *
 * Resets FIRST, then applies. The overrides in a settings file are sparse — only what the user
 * changed — so applying them onto whatever the palette currently holds would make this function
 * additive: switching from a theme that recoloured `accent` to one that does not would leave the
 * old accent standing, because the new theme says nothing about it. Going back to the shipped
 * palette each time makes the file the whole truth rather than the most recent layer of it.
 */
export function applySettings(settings: Settings): void {
  resetPalette();
  applyPalette(settings.palette);
  // Unknown names fall back to the default inside `setCodeTheme`, so a theme removed in a later
  // build costs the user their choice for that session rather than throwing on boot.
  setCodeTheme(settings.codeTheme);
}
