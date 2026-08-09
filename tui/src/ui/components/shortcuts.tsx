import React from "react";
import { GLOBAL, LISTS, type Binding } from "../bindings.js";
import { theme } from "../theme.js";

const INDENT = "  ";
const GAP = 3;
const MIN_DESCRIPTION = 8;
const MIN_ROWS = 3;

export function shortcutRows(height: number): number {
  return Math.max(2, Math.floor(height / 3));
}

export function Shortcuts(props: {
  bindings: readonly Binding[];
  width: number;
  /** How many rows the footer can spare. See `shortcutRows`. */
  maxRows: number;
}): React.ReactNode {
  const { columns, rows } = layout(props.bindings, props.width, props.maxRows);

  return (
    <box flexDirection="column" flexShrink={0}>
      {Array.from({ length: rows }, (_, row) => (
        <text key={row} fg={theme.dim}>
          {INDENT}
          {columns.map((column, index) => {
            const binding = column.bindings[row];
            if (!binding) return null;
            const last =
              index === columns.length - 1 ||
              !columns[index + 1]?.bindings[row];
            const does = fit(binding[1], column.does);
            return (
              <React.Fragment key={binding[0]}>
                <span fg={theme.accent}>
                  {binding[0].padEnd(column.key + 1)}
                </span>
                <span>{last ? does : does.padEnd(column.does + GAP)}</span>
              </React.Fragment>
            );
          })}
        </text>
      ))}
    </box>
  );
}

type Column = { bindings: readonly Binding[]; key: number; does: number };

function layout(
  bindings: readonly Binding[],
  width: number,
  maxRows: number,
): { columns: Column[]; rows: number } {
  const available = width - INDENT.length;
  const widest = Math.max(1, Math.ceil(bindings.length / MIN_ROWS));
  const needed = Math.max(1, Math.ceil(bindings.length / Math.max(1, maxRows)));

  let best = 1;
  for (let count = 2; count <= widest; count++) {
    if (measure(split(bindings, count, Infinity)) <= available) best = count;
  }
  if (best >= needed) {
    return {
      columns: split(bindings, best, Infinity),
      rows: rowsIn(bindings, best),
    };
  }

  // Too tall at that width. Buy the columns the budget needs by shaving descriptions instead.
  for (let count = needed; count > best; count--) {
    const shaved = split(bindings, count, MIN_DESCRIPTION);
    if (measure(shaved) > available) continue;
    // Somewhere between shaved and full fits; find it rather than truncating harder than needed.
    const spread = Math.floor((available - measure(shaved)) / count);
    return {
      columns: split(bindings, count, MIN_DESCRIPTION + spread),
      rows: rowsIn(bindings, count),
    };
  }

  return {
    columns: split(bindings, best, Infinity),
    rows: rowsIn(bindings, best),
  };
}

function rowsIn(bindings: readonly Binding[], columns: number): number {
  return Math.ceil(bindings.length / columns);
}

/** Column-major, so each column reads top to bottom and the order survives a resize. */
function split(
  bindings: readonly Binding[],
  count: number,
  cap: number,
): Column[] {
  const rows = rowsIn(bindings, count);
  const columns: Column[] = [];
  for (let index = 0; index < count; index++) {
    const slice = bindings.slice(index * rows, (index + 1) * rows);
    if (slice.length === 0) continue;
    columns.push({
      bindings: slice,
      key: keyWidth(slice),
      does: Math.min(cap, Math.max(...slice.map(([, does]) => does.length))),
    });
  }
  return columns;
}

function keyWidth(bindings: readonly Binding[]): number {
  return Math.max(...bindings.map(([key]) => key.length));
}

function measure(columns: Column[]): number {
  return (
    columns.reduce((total, column) => total + column.key + 1 + column.does, 0) +
    GAP * (columns.length - 1)
  );
}

function fit(does: string, width: number): string {
  return does.length <= width
    ? does
    : `${does.slice(0, Math.max(0, width - 1))}…`;
}

export function ListShortcuts(props: {
  width: number;
  height: number;
}): React.ReactNode {
  return (
    <box flexDirection="column">
      <Shortcuts
        bindings={[...LISTS, ...GLOBAL]}
        width={props.width}
        maxRows={shortcutRows(props.height)}
      />
      <text fg={theme.dim}>{INDENT}? close</text>
    </box>
  );
}
