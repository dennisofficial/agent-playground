import { useEffect, useState } from "react";
import {
  cachedHighlight,
  highlightRows,
  type HighlightedRows,
} from "../markdown/highlight-rows.js";

/**
 * Syntax colours for a set of diff rows, once the parser worker has them.
 *
 * The awkward part of highlighting a transcript row is that highlighting is ASYNCHRONOUS and a row
 * is not: `DiffView` is otherwise a pure function of its props, rendered inside a scrollbox that
 * may draw it many times a second. So the pass runs in an effect and the row renders plain until it
 * lands — a diff is readable without colour, and a frame withheld until the worker answers would be
 * a worse trade than a frame that gains colour a moment later.
 *
 * A cache hit resolves in the initial state rather than through an effect, which is what stops a
 * scroll from flashing every diff back to plain and then re-colouring it.
 */
export function useHighlightedRows(args: {
  lines: readonly string[];
  filetype: string | null;
}): HighlightedRows {
  const { lines, filetype } = args;
  // The identity a re-render must be compared on. The rows are rebuilt from hunks on every render,
  // so the ARRAY is new every time and only its contents mean anything.
  const key = filetype === null ? null : `${filetype} ${lines.join("\n")}`;

  const [state, setState] = useState<{ key: string | null; rows: HighlightedRows }>(
    () => ({ key, rows: key === null || filetype === null ? null : cachedHighlight(lines, filetype) ?? null }),
  );

  useEffect(() => {
    if (key === null || filetype === null) return;

    const hit = cachedHighlight(lines, filetype);
    if (hit !== undefined) {
      setState({ key, rows: hit });
      return;
    }

    // An unmount, or a change of content, must not let a stale pass overwrite a fresh one — the
    // worker answers out of order under load, and a diff is re-keyed by every expand.
    let live = true;
    void highlightRows({ lines, filetype }).then((rows) => {
      if (live) setState({ key, rows });
    });
    return () => {
      live = false;
    };
    // `lines` is deliberately not a dependency: `key` already encodes its contents, and the array
    // itself is a fresh reference on every render, which would make this effect fire forever.
  }, [key, filetype]);

  // Content changed this render and the effect has not run yet — render plain rather than paint the
  // PREVIOUS diff's colours onto this one's text, which would mis-colour rather than under-colour.
  return state.key === key ? state.rows : null;
}
