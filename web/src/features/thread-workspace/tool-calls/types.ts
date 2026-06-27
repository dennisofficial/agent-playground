import type { ComponentType } from 'react';

/**
 * Tool-call rendering — shared types for the pluggable renderer registry.
 *
 * Each tool call is rendered by a {@link ToolHandler} resolved from {@link resolveHandler}. A handler
 * turns a {@link ToolItem} into a {@link ToolDescriptor} (the one-line collapsed row) and optionally
 * supplies a custom expanded body. Unknown tools fall through to the generic handler.
 */

/** One tool call, as captured by the brain's turn streamer (`meta: { name, input, result, isError }`). */
export interface ToolItem {
  key: string;
  name: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  running?: boolean;
}

export type IconKind = 'bash' | 'read' | 'edit' | 'write' | 'grep' | 'mcp';

/** Right-aligned badge on a tool row. */
export type ToolBadge =
  | { kind: 'diffstat'; added: number; removed: number | null }
  | { kind: 'lines'; n: number }
  | { kind: 'error' }
  | null;

/** The collapsed one-line treatment for a tool row + its group-preview token. */
export interface ToolDescriptor {
  icon: IconKind;
  /** Bold label for native tools; '' for mcp-style rows (the name takes the inline slot). */
  label: string;
  /** The key argument shown inline (command / path / pattern), or the friendly tool name. */
  arg: string;
  /** When true, `arg` is a file path: the directory prefix is dimmed and the filename normal. */
  pathArg?: boolean;
  /** Short token for the collapsed group's preview line. */
  preview: string;
  /** Icon/label accent color (a `var(--…)` token). */
  color: string;
  /** Renders as a blue `mcp · name` row (no bold label). */
  isMcp: boolean;
  /** Optional add-toned pill before the badge (e.g. "NEW" on a freshly written file). */
  pill?: string;
  badge: ToolBadge;
}

/** A pluggable renderer for one family of tools. */
export interface ToolHandler {
  /** Stable id, for debugging/tests. */
  id: string;
  /** True when this handler owns the given tool. Evaluated in registry order; generic matches last. */
  match(name: string, input: unknown): boolean;
  /** The collapsed row treatment. */
  describe(tool: ToolItem): ToolDescriptor;
  /** Custom expanded body. When omitted, the default body (terminal / structured panel) renders. */
  Body?: ComponentType<{ tool: ToolItem }>;
}
