import type { Selection } from "@opentui/core";
import { useRenderer, useSelectionHandler } from "@opentui/react";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { copyToClipboard } from "./clipboard.js";

/** Long enough to read, short enough that it never becomes chrome. */
const NOTICE_MS = 1500;

export type CopyNotice = { text: string; ok: boolean };

const CopyNoticeContext = createContext<CopyNotice | null>(null);

export function useCopyOnSelect(): CopyNotice | null {
  const renderer = useRenderer();
  const [notice, setNotice] = useState<CopyNotice | null>(null);
  // One clipboard write per finished selection.
  //
  // The renderer announces a selection from `finishSelection` only, so every event here is a settled
  // one — but the SAME selection is announced again by anything that finishes it a second time (a
  // ctrl+click extension, a mouse-up that changed nothing), while each fresh drag builds a NEW
  // Selection. Identity plus text is therefore what separates "again" from "another", and a latch
  // that reset on drag would never fire twice: there are no mid-drag events to reset it.
  const last = useRef<{ selection: Selection; text: string } | null>(null);

  useSelectionHandler((selection) => {
    // Belt and braces: 0.4.5 only ever announces settled selections, and if that changes, a PREFIX
    // of what the user is dragging must not be what lands on their clipboard.
    if (selection.isDragging) return;

    // A cleared selection arrives here too. Writing its empty string would destroy whatever the user
    // had on their clipboard, which is the one loss they cannot undo.
    const text = selection.getSelectedText();
    if (text.trim().length === 0) return;
    if (last.current?.selection === selection && last.current.text === text)
      return;
    last.current = { selection, text };

    const ok = copyToClipboard(renderer, text);
    setNotice({ text: ok ? describe(text) : "clipboard unavailable", ok });
  });

  // Keyed on the notice OBJECT, not on its text. Every copy commits a fresh object even when the
  // message is identical, so copying twice in a row restarts the countdown — an equal string would
  // leave the second confirmation to vanish on the first one's timer.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return notice;
}

/**
 * What was copied, in the fewest words that still confirm the RIGHT thing was copied — a line count
 * is what catches a drag that grabbed one row more than the eye thought it had.
 */
function describe(text: string): string {
  const lines = text.trim().split("\n").length;
  return lines > 1 ? `copied ${lines} lines` : "copied";
}

export function CopyNoticeProvider(props: {
  notice: CopyNotice | null;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <CopyNoticeContext.Provider value={props.notice}>
      {props.children}
    </CopyNoticeContext.Provider>
  );
}

export function useCopyNotice(): CopyNotice | null {
  return useContext(CopyNoticeContext);
}
