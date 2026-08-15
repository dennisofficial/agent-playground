import { Injectable } from "@nestjs/common";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ATLAS_PATHS } from "../domain/paths.js";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  serialiseSettings,
  type Settings,
} from "../domain/settings.js";

/**
 * Owns `~/.atlas/settings.json` — reads it, writes it, and tells anyone watching.
 *
 * Deliberately knows NOTHING about colours. `app/` may not import `ui/`, and that constraint turns
 * out to be the right seam anyway: this layer's job is that a value survives a restart, and
 * deciding what a value MEANS to a palette is the renderer's. `ui/apply-settings.ts` is the half
 * that reads a `Settings` and repaints; swapping either does not disturb the other.
 *
 * Synchronous `node:fs` throughout, like `ClaimService`. The file is small, it is read once before
 * the first frame, and an async read here would mean the app could paint in the wrong theme and
 * then correct itself — a visible flash, for no gain.
 */
@Injectable()
export class SettingsService {
  private settings: Settings = DEFAULT_SETTINGS;

  private readonly listeners = new Set<() => void>();

  /**
   * Read from disk, or fall back to the defaults.
   *
   * No file is the normal case, not an error — every install starts without one. An unreadable or
   * malformed file is treated identically on purpose: `parseSettings` is tolerant per key, so what
   * reaches here is always a usable object, and the worst outcome is a session in default colours.
   */
  load(): Settings {
    try {
      this.settings = parseSettings(readFileSync(ATLAS_PATHS.settings, "utf8"));
    } catch {
      this.settings = DEFAULT_SETTINGS;
    }
    return this.settings;
  }

  current = (): Settings => this.settings;

  /** Arrow-bound so `useSyncExternalStore` gets a stable identity — see `palette-store.ts`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Write, then announce.
   *
   * In memory first and on disk second, so a full disk costs the user the persistence and not the
   * edit they are in the middle of making — the editor stays live, and the failure surfaces the
   * next time they look at the file rather than by reverting a colour under the cursor.
   *
   * Several Atlas instances run at once and this does not try to reconcile them: the last writer
   * wins the file, and the others keep the theme they loaded until they restart. That is the right
   * trade for a preference and would be the wrong one for state — a colour going stale in another
   * window costs nothing, where a stale claim or a stale account would cost correctness.
   */
  save(settings: Settings): void {
    this.settings = settings;
    for (const listener of this.listeners) listener();

    mkdirSync(ATLAS_PATHS.home, { recursive: true });
    writeFileSync(ATLAS_PATHS.settings, serialiseSettings(settings), "utf8");
  }
}
