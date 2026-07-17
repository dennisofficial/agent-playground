/**
 * Hub-side middleware: when a proxied `tools/call` result is large, write the full (already-redacted)
 * payload to a file under `/playground/atlas-mcp/` and return a compact `{dumpedTo, format, rowCount,
 * bytes, preview, hint}` envelope instead. Small results and errors pass through unchanged. Pure/injectable
 * so it is unit-testable without touching the real filesystem; wired into the CallTool handler in
 * `mcp-hub-server.ts`.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { CONTAINER_PLAYGROUND } from '../container-paths';

export const DUMP_THRESHOLD_BYTES = 25_000; // ~6k tokens; below this, keep inline
export const DUMP_SUBDIR = 'atlas-mcp';
const PREVIEW_LINES = 20;
const PREVIEW_MAX_BYTES = 2_000;

// SECURITY (d5): result content is attacker-controlled generic MCP output, and the hub writes as ROOT.
// The file extension is the ONLY place a payload field feeds the write path — clamp it to a fixed
// allowlist so nothing derived from a tool result can traverse out of the dump dir.
const ALLOWED_EXT = new Set(['json', 'jsonl', 'csv', 'tsv', 'txt']);
const clampExt = (ext: string): string => (ALLOWED_EXT.has(ext) ? ext : 'txt');

/** Strip a tool name to a safe filename component — no `/` or `..` can survive. */
const safe = (toolName: string): string => toolName.replace(/[^a-zA-Z0-9_-]/g, '');

/** Compact, hub-controlled (UTC) timestamp for the dump filename, e.g. `20260712-031500`. */
function tsCompact(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

export type DumpDeps = {
  playgroundDir: string;
  writeFile: (path: string, data: string) => void;
  mkdir: (path: string) => void;
  now: () => Date;
  rand: () => string;
};

const defaultDeps: DumpDeps = {
  playgroundDir: CONTAINER_PLAYGROUND,
  writeFile: (p, d) => writeFileSync(p, d, { mode: 0o644 }),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  now: () => new Date(),
  rand: () => randomBytes(2).toString('hex'),
};

/** Dump-scope gate (d5: ALL user MCP servers). Kept as a named predicate — not inlined — so it stays the
 *  single, obvious place to narrow scope later. Only affects servers routed through this hub; reserved
 *  control-plane tools use a different bridge and never reach this handler. */
export function isDumpEnabled(_serverName: string): boolean {
  return true;
}

type Extracted = {
  payload: string;
  ext: string;
  rowCount?: unknown;
  truncated?: unknown;
  previewSource: string;
};

const firstLines = (text: string, n: number): string => text.split('\n').slice(0, n).join('\n');

/** Parse the reader's `atlas_query` envelope (or fall back to generic JSON/text) into the payload that
 *  actually gets written to disk, so the file holds the clean rows/text rather than the JSON wrapper. */
function extract(text: string): Extracted {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      payload: text,
      ext: 'txt',
      previewSource: firstLines(text, PREVIEW_LINES),
    };
  }

  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.format === 'string') {
      if (obj.format === 'json' && Array.isArray(obj.rows)) {
        const rows = obj.rows as unknown[];
        return {
          payload: JSON.stringify(rows, null, 2),
          ext: 'json',
          rowCount: obj.rowCount,
          truncated: obj.truncated,
          previewSource: rows
            .slice(0, PREVIEW_LINES)
            .map((r) => JSON.stringify(r))
            .join('\n'),
        };
      }
      if (
        typeof obj.text === 'string' &&
        (obj.format === 'jsonl' || obj.format === 'csv' || obj.format === 'tsv')
      ) {
        return {
          payload: obj.text,
          ext: obj.format,
          rowCount: obj.rowCount,
          truncated: obj.truncated,
          previewSource: firstLines(obj.text, PREVIEW_LINES),
        };
      }
      // Unrecognized envelope (including a hostile `format` value) — fall through to the generic branch;
      // `format` never gets to name the extension unless it's a trusted value handled above.
    }
  }
  return {
    payload: text,
    ext: 'json',
    previewSource: firstLines(text, PREVIEW_LINES),
  };
}

export function maybeDumpLargeResult(
  input: {
    serverName: string;
    toolName: string;
    args: Record<string, unknown> | undefined;
    result: CallToolResult;
  },
  deps?: Partial<DumpDeps>,
): CallToolResult {
  const { serverName, toolName, result } = input;
  if (!isDumpEnabled(serverName) || result.isError) return result;

  const content = result.content ?? [];
  if (content.length === 0 || content.some((c) => c.type !== 'text')) return result;

  const text = content.map((c) => (c as { text: string }).text).join('');
  if (Buffer.byteLength(text, 'utf8') <= DUMP_THRESHOLD_BYTES) return result;

  const { payload, ext, rowCount, truncated, previewSource } = extract(text);
  const clamped = clampExt(ext);
  const resolvedDeps: DumpDeps = { ...defaultDeps, ...deps };

  try {
    const dir = join(resolvedDeps.playgroundDir, DUMP_SUBDIR);
    resolvedDeps.mkdir(dir);
    const stamp = tsCompact(resolvedDeps.now());
    const file = join(dir, `${safe(toolName)}-${stamp}-${resolvedDeps.rand()}.${clamped}`);
    // Containment assertion (belt-and-suspenders): every filename component is already sanitized
    // (safe() strips to [A-Za-z0-9_-] so no '.'/'/'; ext is allowlisted), but assert the resolved path
    // is still inside `dir` and bail to inline if not — the hub runs as root, so never write outside.
    if (!resolve(file).startsWith(resolve(dir) + sep)) return result;
    resolvedDeps.writeFile(file, payload);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              dumpedTo: file,
              tool: toolName,
              format: clamped,
              rowCount,
              truncated,
              bytes: Buffer.byteLength(payload, 'utf8'),
              preview: previewSource.slice(0, PREVIEW_MAX_BYTES),
              hint:
                'Full result written to a file to keep it out of context. Inspect it in the sandbox: ' +
                'head/wc -l, grep, jq, python, or duckdb -c "SELECT ... FROM \'<file>\'".',
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    console.error(`[mcp-hub-dump] failed to dump result for ${toolName}: ${String(err)}`);
    return result;
  }
}
