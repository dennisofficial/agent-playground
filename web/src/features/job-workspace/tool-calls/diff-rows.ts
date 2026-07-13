import { diffLines } from "diff";
import type { DiffHunk } from "./types";

/** Shared diff-row helpers — turning raw text/hunks into numbered rows the diff renderers paint.
 *  Extracted from `ui.tsx` so the full Changes-pane diff (`diff-pane.tsx`) can reuse `rowsFromHunk`. */

export type DiffRow = {
  key: number;
  type: "context" | "add" | "del";
  oldNo?: number;
  newNo?: number;
  code: string;
};

/** Drop the trailing empty element a terminal `\n` leaves after split, but keep interior blank lines. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Walk a jsdiff line-diff into numbered rows + the old/new line totals for the hunk header. */
export function computeDiffRows(
  before: string,
  after: string,
): { rows: DiffRow[]; oldCount: number; newCount: number } {
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let key = 0;
  for (const part of diffLines(before, after)) {
    const type = part.added ? "add" : part.removed ? "del" : "context";
    for (const code of splitLines(part.value)) {
      if (type === "add") rows.push({ key: key++, type, newNo: newNo++, code });
      else if (type === "del")
        rows.push({ key: key++, type, oldNo: oldNo++, code });
      else
        rows.push({ key: key++, type, oldNo: oldNo++, newNo: newNo++, code });
    }
  }
  return { rows, oldCount: oldNo - 1, newCount: newNo - 1 };
}

/** Walk one structured-patch hunk into numbered rows, seeding line numbers from its real file offsets. */
export function rowsFromHunk(hunk: DiffHunk, keyBase: number): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  let key = keyBase;
  for (const raw of hunk.lines) {
    const sign = raw[0];
    const code = raw.slice(1);
    if (sign === "+")
      rows.push({ key: key++, type: "add", newNo: newNo++, code });
    else if (sign === "-")
      rows.push({ key: key++, type: "del", oldNo: oldNo++, code });
    else if (sign === "\\")
      continue; // "\ No newline at end of file" marker — not a real line
    else
      rows.push({
        key: key++,
        type: "context",
        oldNo: oldNo++,
        newNo: newNo++,
        code,
      });
  }
  return rows;
}
