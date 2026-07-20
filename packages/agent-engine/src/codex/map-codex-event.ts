import type { CodexEvent, CodexItem } from '@workspace/codex-sdk';
import { structuredPatch as diffStructuredPatch } from 'diff';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { EngineEvent, StructuredPatchHunk } from '../types.js';

/**
 * The Codex `file_change` change kinds. Declared locally rather than imported from `@openai/codex-sdk`
 * (a backend-only vendor dep this standalone package must not reach for) — the equivalent of
 * `FileChangeItem['changes'][number]['kind']`.
 */
export type FileChangeKind = 'add' | 'delete' | 'update';

export interface MapCodexEventCtx {
  /** Worktree root, for reconstructing a `file_change`'s HEAD-relative diff. */
  cwd: string;
  /** When set, emit the authoritative rich-stream blocks (thinking / tool_use+tool_result pairs / deltas);
   *  otherwise emit the coarse `text`/`tool` events the durable transcript keeps. */
  richStream: boolean;
  /** Called with an `agent_message`'s full text so the caller can track the running turn summary without
   *  the mapper holding turn state. */
  onResult?: (text: string) => void;
}

/**
 * The ONE Atlas↔Codex event mapping: a Codex-native {@link CodexEvent} → zero, one, or two Atlas
 * {@link EngineEvent}s. Returns an ARRAY because a single Codex `item/completed` (command_execution,
 * file_change, web_search) expands into a `tool_use`+`tool_result` PAIR under `richStream`, and a
 * multi-file `file_change` fans out into one pair per file. Pure aside from `ctx.onResult` (the running
 * summary hook) and the git/fs reads inside {@link computeCodexStructuredPatch}.
 */
export function mapCodexEvent(e: CodexEvent, ctx: MapCodexEventCtx): EngineEvent[] {
  switch (e.type) {
    case 'itemCompleted':
      return mapItemCompleted(e.item, ctx);
    case 'agentMessageDelta':
      return ctx.richStream ? [{ kind: 'text_delta', text: e.delta }] : [];
    case 'reasoningTextDelta':
    case 'reasoningSummaryTextDelta':
      return ctx.richStream ? [{ kind: 'thinking_delta', text: e.delta }] : [];
    // turnStarted / itemStarted / commandExecutionOutputDelta / fileChangePatchUpdated / turnDiffUpdated /
    // tokenUsageUpdated / turnCompleted / unknown carry no Atlas EngineEvent in thread 2 — turnCompleted's
    // usage/status is consumed directly off the `startTurn` result, not through this per-notification mapper.
    default:
      return [];
  }
}

function mapItemCompleted(item: CodexItem, ctx: MapCodexEventCtx): EngineEvent[] {
  switch (normalizeItemType(item.type)) {
    case 'agentMessage': {
      const text = asStr(item.text);
      ctx.onResult?.(text);
      return [{ kind: 'text', text }];
    }
    case 'plan': {
      const text = asStr(item.text);
      ctx.onResult?.(text);
      return [{ kind: 'text', text }];
    }
    case 'reasoning': {
      const text = firstText(item.text, item.content, item.summary);
      return [ctx.richStream ? { kind: 'thinking', text } : { kind: 'text', text }];
    }
    case 'commandExecution':
      return mapCommandExecution(item, ctx);
    case 'fileChange':
      return mapFileChange(item, ctx);
    case 'webSearch':
      return mapWebSearch(item, ctx);
    case 'error':
      return [{ kind: 'text', text: `error: ${asStr(item.message)}` }];
    default:
      return [];
  }
}

function mapCommandExecution(item: CodexItem, ctx: MapCodexEventCtx): EngineEvent[] {
  const command = asStr(item.command);
  if (!ctx.richStream) return [{ kind: 'tool', name: 'bash', detail: command }];
  const exitCode = asNum(item.exitCode ?? item.exit_code);
  const status = asStr(item.status);
  const isError =
    status === 'failed' || status === 'declined' || (exitCode != null && exitCode !== 0);
  return [
    { kind: 'tool_use', id: item.id, name: 'bash', input: { command } },
    {
      kind: 'tool_result',
      id: item.id,
      result: item.aggregatedOutput ?? item.aggregated_output,
      isError,
    },
  ];
}

function mapFileChange(item: CodexItem, ctx: MapCodexEventCtx): EngineEvent[] {
  // `changes: [{path, kind}]` + `status` are the verified app-server shape (see the SDK's
  // fake-app-server fixture). Codex bundles every file a patch touched into ONE item.
  const changes = asChanges(item.changes);
  if (!ctx.richStream) {
    return [
      {
        kind: 'tool',
        name: 'edit',
        detail: changes.map((c) => `${c.kind} ${c.path}`).join(', '),
      },
    ];
  }
  const status = asStr(item.status);
  const multi = changes.length > 1;
  // Split into one tool_use/tool_result pair per file (mirroring Claude's one-file-per-Edit shape) so each
  // gets its own diff card instead of a single card with no renderable content.
  return changes.flatMap((change, idx): EngineEvent[] => {
    const id = multi ? `${item.id}:${idx}` : item.id;
    return [
      {
        kind: 'tool_use',
        id,
        name: 'edit',
        input: { file_path: change.path, kind: change.kind },
      },
      {
        kind: 'tool_result',
        id,
        result: status,
        isError: status === 'failed',
        structuredPatch: computeCodexStructuredPatch(ctx.cwd, change.path, change.kind),
      },
    ];
  });
}

function mapWebSearch(item: CodexItem, ctx: MapCodexEventCtx): EngineEvent[] {
  const query = asStr(item.query);
  if (!ctx.richStream) return [{ kind: 'tool', name: 'web_search', detail: query }];
  return [
    { kind: 'tool_use', id: item.id, name: 'web_search', input: { query } },
    { kind: 'tool_result', id: item.id, result: 'completed' },
  ];
}

/**
 * Codex's `file_change` item reports only `{ path, kind }` — never the before/after content needed to
 * render a diff (unlike Claude's Edit tool, which carries `old_string`/`new_string` + a `structuredPatch`).
 * Reconstruct one: the last committed blob (`git show HEAD:path`) stands in for "before" and the current
 * on-disk file for "after". A HEAD-relative diff, not a per-edit one — fine as long as the worktree isn't
 * committed mid-turn (it isn't).
 */
export function computeCodexStructuredPatch(
  cwd: string,
  path: string,
  kind: FileChangeKind,
): StructuredPatchHunk[] | undefined {
  let oldContent = '';
  if (kind !== 'add') {
    try {
      oldContent = execFileSync('git', ['show', `HEAD:${path}`], {
        cwd,
        encoding: 'utf8',
      });
    } catch {
      oldContent = '';
    }
  }
  let newContent = '';
  if (kind !== 'delete') {
    try {
      const abs = resolvePath(cwd, path);
      newContent = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    } catch {
      newContent = '';
    }
  }
  if (!oldContent && !newContent) return undefined;
  const patch = diffStructuredPatch(path, path, oldContent, newContent, undefined, undefined, {
    context: 3,
  });
  return patch.hunks.length ? patch.hunks : undefined;
}

function asStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNum(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function normalizeItemType(type: string): string {
  switch (type) {
    case 'agent_message':
      return 'agentMessage';
    case 'command_execution':
      return 'commandExecution';
    case 'file_change':
      return 'fileChange';
    case 'web_search':
      return 'webSearch';
    default:
      return type;
  }
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value)) {
      const text = value
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join('\n');
      if (text.length > 0) return text;
    }
  }
  return '';
}

function asChanges(value: unknown): Array<{ path: string; kind: FileChangeKind }> {
  if (!Array.isArray(value)) return [];
  return value.map((c) => {
    const r = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    return { path: asStr(r.path), kind: asChangeKind(r.kind) };
  });
}

function asChangeKind(value: unknown): FileChangeKind {
  if (value === 'add' || value === 'delete' || value === 'update') return value;
  const r = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const type = asStr(r.type);
  if (type === 'add' || type === 'delete' || type === 'update') return type;
  return 'update';
}
