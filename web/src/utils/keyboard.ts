import type { KeyboardEvent } from "react";

/**
 * The "submit this form" chord: ⌘+Enter on macOS, Ctrl+Enter on Windows/Linux. Used on multi-line
 * textareas where plain Enter inserts a newline, so the operator can send without reaching for the mouse.
 * Matches the ⌘/Ctrl+K convention used for the command palette.
 */
export function isSubmitCombo(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key === "Enter";
}
