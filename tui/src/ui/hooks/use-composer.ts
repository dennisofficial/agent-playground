import { decodePasteBytes, stripAnsiSequences } from "@opentui/core";
import { usePaste } from "@opentui/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { applyKey } from "../../domain/editor.js";
import type { KeyChord } from "../../domain/editor-keymap.js";
import {
  EMPTY_EDITOR,
  fromText,
  insert,
  moveTo,
  type EditorState,
} from "../../domain/text-editor.js";

export type ComposerControls = {
  value: string;
  state: EditorState;
  setValue: (value: string) => void;
  clear: () => void;
  setCursor: (index: number) => void;
  handleKey: (input: string, key: KeyChord) => boolean;
};

export type ComposerOptions = {
  singleLine?: boolean;
};

export function useComposer(
  initial = "",
  options: ComposerOptions = {},
): ComposerControls {
  const [state, setState] = useState<EditorState>(() =>
    initial.length > 0 ? fromText(initial) : EMPTY_EDITOR,
  );

  // The ref mirrors state so `handleKey` can answer synchronously — `setState` updaters do not run
  // in time to decide whether the key was consumed. It also keeps rapid keystrokes consistent,
  // since each commit updates the ref before the next key arrives.
  const latest = useRef(state);
  latest.current = state;

  const commit = useCallback((next: EditorState) => {
    latest.current = next;
    setState(next);
  }, []);

  const clear = useCallback(() => commit(EMPTY_EDITOR), [commit]);
  const setValue = useCallback(
    (value: string) => commit(fromText(value)),
    [commit],
  );
  const setCursor = useCallback(
    (index: number) => commit(moveTo(latest.current, index)),
    [commit],
  );

  // ⌘V never arrives as keystrokes. The renderer turns bracketed paste on, so the clipboard lands as
  // ONE event on its own channel — and `useInput` drops multi-character sequences besides, so with
  // no listener here a paste is silently discarded rather than mangled, which is worse.
  //
  // At most one composer is mounted at a time (the navigation stack shows one page), so this is the
  // only listener and a paste has exactly one destination.
  usePaste((event) => {
    const chunk = pasted(
      decodePasteBytes(event.bytes),
      options.singleLine === true,
    );
    if (chunk.length > 0) commit(insert(latest.current, chunk));
  });

  const handleKey = useCallback(
    (input: string, key: KeyChord): boolean => {
      const { next, consumed } = applyKey(latest.current, input, key);
      if (consumed) commit(next);
      return consumed;
    },
    [commit],
  );

  return useMemo(
    () => ({ value: state.text, state, setValue, clear, setCursor, handleKey }),
    [state, setValue, clear, setCursor, handleKey],
  );
}

function pasted(raw: string, singleLine: boolean): string {
  const text = stripAnsiSequences(raw);
  return singleLine ? text.replace(/\s*\r?\n\s*/g, " ").trim() : text;
}
