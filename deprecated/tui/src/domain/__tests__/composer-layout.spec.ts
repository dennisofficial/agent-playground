import { describe, expect, it } from 'bun:test';
import { indexAt, layoutComposer } from "../composer-layout.js";
import type { EditorState } from "../text-editor.js";

function at(marked: string): EditorState {
  const cursor = marked.indexOf("|");
  return { text: marked.replace("|", ""), cursor, goalColumn: null };
}

/** Rows rendered back into the `|` notation, so a layout reads like the composer looks. */
function render(rows: { text: string; caret: number | null }[]): string[] {
  return rows.map((row) =>
    row.caret === null
      ? row.text
      : `${row.text.slice(0, row.caret)}|${row.text.slice(row.caret)}`,
  );
}

describe("logical lines", () => {
  it("gives each line its own row and marks the caret on one of them", () => {
    const layout = layoutComposer(at("one\ntw|o"), 20, 8);
    expect(render(layout.rows)).toEqual(["one", "tw|o"]);
  });

  it("keeps a blank line the user typed", () => {
    const layout = layoutComposer(at("one\n\n|two"), 20, 8);
    expect(render(layout.rows)).toEqual(["one", "", "|two"]);
  });

  it("puts the caret at the end of the text", () => {
    const layout = layoutComposer(at("hello|"), 20, 8);
    expect(render(layout.rows)).toEqual(["hello|"]);
  });
});

describe("wrapping", () => {
  it("moves a whole word down instead of breaking it", () => {
    // The bug this pins: character folding rendered `hello wo` / `rld`, so the draft appeared to
    // contain words the user never typed.
    const layout = layoutComposer(at("hello world|"), 8, 8);
    expect(render(layout.rows).map((row) => row.trimEnd())).toEqual(["hello", "world|"]);
  });

  it("keeps the caret with its word across the fold", () => {
    const layout = layoutComposer(at("hello wo|rld"), 8, 8);
    expect(render(layout.rows).map((row) => row.trimEnd())).toEqual(["hello", "wo|rld"]);
  });

  it("still folds a word too long for any row", () => {
    // No space to break at, so the alternative is a row it cannot fit on.
    const layout = layoutComposer(at("abcdefg|hij"), 5, 8);
    expect(render(layout.rows)).toEqual(["abcde", "fg|hij"]);
  });

  it("puts a caret at a fold boundary on the continuation row, not past the end", () => {
    const layout = layoutComposer(at("abcde|fghij"), 5, 8);
    expect(render(layout.rows)).toEqual(["abcde", "|fghij"]);
  });

  // A caret at the end of an exactly-full row has no column left, so it earns a fresh one.
  it("opens a new row for a caret at the end of an exactly-full line", () => {
    const layout = layoutComposer(at("abcde|"), 5, 8);
    expect(render(layout.rows)).toEqual(["abcde", "|"]);
  });

  it("folds each logical line independently", () => {
    const layout = layoutComposer(at("abcdefg\nx|y"), 5, 8);
    expect(render(layout.rows)).toEqual(["abcde", "fg", "x|y"]);
  });
});

describe("the caret margin", () => {
  // Seven visible rows of a ten-row draft, so there is somewhere to scroll in both directions.
  const tenLines = Array.from({ length: 10 }, (_, index) => `l${index + 1}`).join("\n");
  const ROWS = 7;

  /** The draft with the caret on `row` (0-indexed), and the window parked at `top`. */
  function windowAt(row: number, top: number): number {
    const cursor = tenLines.split("\n").slice(0, row).join("\n").length + (row > 0 ? 1 : 0);
    const state: EditorState = { text: tenLines, cursor, goalColumn: null };
    return layoutComposer(state, 20, ROWS, { top, revealCaret: true }).hiddenAbove;
  }

  it("holds still while the caret moves down to one row from the bottom", () => {
    // Rows 0..5 of a seven-row window: row 5 is the sixth, and row 6 is still on screen below it.
    for (const row of [0, 1, 2, 3, 4, 5]) expect(windowAt(row, 0)).toBe(0);
  });

  it("scrolls by one when the caret would take the last visible row", () => {
    expect(windowAt(6, 0)).toBe(1);
    expect(windowAt(7, 1)).toBe(2);
  });

  it("holds still coming back up until the caret reaches the second row", () => {
    // Window on rows 2..8, so the caret is free between rows 3 and 7 — a row of margin at each edge.
    for (const row of [7, 6, 5, 4, 3]) expect(windowAt(row, 2)).toBe(2);
    expect(windowAt(2, 2)).toBe(1);
  });

  it("gives up the margin at the ends of the draft", () => {
    // Nothing above row 0 to keep in view, so the caret takes the first row rather than holding a
    // blank one above it. Same at the bottom.
    expect(windowAt(0, 1)).toBe(0);
    expect(windowAt(9, 2)).toBe(3);
  });

  it("leaves the window alone when the caret did not move", () => {
    const state: EditorState = { text: tenLines, cursor: 0, goalColumn: null };
    // A wheel report parks the window five rows down while the caret sits on row 0 — and it stays
    // there, off-caret, until something reveals the caret again.
    const layout = layoutComposer(state, 20, ROWS, { top: 3, revealCaret: false });
    expect(layout.hiddenAbove).toBe(3);
    expect(layout.rows.every((row) => row.caret === null)).toBe(true);
  });

  it("still clamps a window parked past the end", () => {
    const state: EditorState = { text: tenLines, cursor: 0, goalColumn: null };
    expect(layoutComposer(state, 20, ROWS, { top: 99, revealCaret: false }).hiddenAbove).toBe(3);
  });
});

describe("clicking", () => {
  it("resolves a click to the character under it", () => {
    const layout = layoutComposer(at("hello|\nworld"), 20, 8);
    expect(indexAt(layout, 0, 2)).toBe(2);
    // Second row, third column: past the newline, so `r` of `world`.
    expect(indexAt(layout, 1, 2)).toBe(8);
  });

  it("resolves a click past the end of a row to that row's end", () => {
    const layout = layoutComposer(at("hi|\nthere"), 20, 8);
    expect(indexAt(layout, 0, 40)).toBe(2);
    expect(indexAt(layout, 1, 40)).toBe(8);
  });

  it("resolves a click on a folded row against the fold, not the logical line", () => {
    // Width 8 folds `hello world` after the space: rows are `hello ` and `world`.
    const layout = layoutComposer(at("hello world|"), 8, 8);
    expect(indexAt(layout, 1, 0)).toBe(6);
    expect(indexAt(layout, 1, 3)).toBe(9);
  });

  it("resolves a click against the SCROLLED rows, not the top of the draft", () => {
    const twelve = Array.from({ length: 12 }, (_, index) => `l${index + 1}`).join("\n");
    const state: EditorState = { text: twelve, cursor: twelve.length, goalColumn: null };
    const layout = layoutComposer(state, 20, 8, { top: 4, revealCaret: false });
    // The first visible row is `l5`, which starts after four two-character lines and their newlines.
    expect(indexAt(layout, 0, 0)).toBe(12);
    expect(layout.rows[0]?.text).toBe("l5");
  });
});

describe("windowing", () => {
  const sixLines = "l1\nl2\nl3\nl4\nl5\nl6";

  it("shows everything when the draft fits", () => {
    const layout = layoutComposer(at(`|${sixLines}`), 20, 8);
    expect(layout.rows).toHaveLength(6);
    expect(layout.hiddenAbove).toBe(0);
    expect(layout.hiddenBelow).toBe(0);
  });

  it("scrolls rather than growing, keeping the caret visible", () => {
    const layout = layoutComposer(at("l1\nl2\nl3\nl4\nl5\n|l6"), 20, 3);
    expect(render(layout.rows)).toEqual(["l4", "l5", "|l6"]);
    expect(layout.hiddenAbove).toBe(3);
    expect(layout.hiddenBelow).toBe(0);
  });

  it("reports the rows hidden below when the caret is near the top", () => {
    const layout = layoutComposer(at("l1\n|l2\nl3\nl4\nl5\nl6"), 20, 3);
    expect(render(layout.rows)).toEqual(["l1", "|l2", "l3"]);
    expect(layout.hiddenAbove).toBe(0);
    expect(layout.hiddenBelow).toBe(3);
  });
});

describe("degenerate widths", () => {
  it("does not divide by zero or loop forever at width 0", () => {
    const layout = layoutComposer(at("ab|c"), 0, 8);
    expect(layout.rows.length).toBeGreaterThan(0);
    expect(render(layout.rows).join("")).toContain("|");
  });

  it("lays out an empty draft as a single caret row", () => {
    const layout = layoutComposer(at("|"), 20, 8);
    expect(render(layout.rows)).toEqual(["|"]);
  });
});
