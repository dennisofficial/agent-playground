import { useKeyboard } from "@opentui/react";

export type InputKey = {
  /** The reporter's name for the key — the only trace of an ESC-prefixed one, whose input is blank. */
  name: string;
  /**
   * Stop the key reaching the focused renderable.
   *
   * OpenTUI dispatches these global handlers BEFORE the focused renderable's own, and skips the
   * renderable when one of them has called this. It is how a page keeps a key the composer's editor
   * would otherwise answer — see `domain/composer-veto.ts`. Pages with no editor on them never need
   * it, which is why it arrives as a method rather than a return value nobody would remember to send.
   */
  preventDefault: () => void;
  /** ⌘ on macOS. Reported only by terminals that speak the kitty protocol. */
  super: boolean;
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  backspace: boolean;
  delete: boolean;
  tab: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
};

/** Printable input for a key event — empty for anything that is purely navigation. */
function printable(event: {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}): string {
  if (event.ctrl) return event.name ?? "";
  const sequence = event.sequence ?? "";
  // Escape sequences are navigation, never text the composer should insert.
  if (sequence.startsWith("\x1b")) return "";
  return sequence.length === 1 ? sequence : "";
}

export function useInput(
  handler: (input: string, key: InputKey) => void,
): void {
  useKeyboard((event) => {
    // Key-repeat and release events would fire a handler written for presses twice.
    if (event.eventType === "release") return;

    const name = event.name ?? "";
    const raw = event as { super?: boolean; option?: boolean };
    handler(printable(event), {
      name,
      preventDefault: () => event.preventDefault(),
      super: Boolean(raw.super),
      upArrow: name === "up",
      downArrow: name === "down",
      leftArrow: name === "left",
      rightArrow: name === "right",
      pageUp: name === "pageup",
      pageDown: name === "pagedown",
      home: name === "home",
      end: name === "end",
      return: name === "return" || name === "enter",
      escape: name === "escape",
      backspace: name === "backspace",
      delete: name === "delete",
      tab: name === "tab",
      ctrl: Boolean(event.ctrl),
      shift: Boolean(event.shift),
      meta: Boolean(event.meta) || Boolean(event.option),
    });
  });
}
