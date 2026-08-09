import { useKeyboard } from "@opentui/react";

export type InputKey = {
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
    handler(printable(event), {
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
