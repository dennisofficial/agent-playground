import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { CONTAINER_PLAYGROUND } from '../container-paths';

export const DUMP_THRESHOLD_BYTES = 25_000; // ~6k tokens; below this, keep inline
export const DUMP_SUBDIR = 'atlas-mcp';
const PREVIEW_LINES = 20;
const PREVIEW_MAX_BYTES = 2_000;

const ALLOWED_EXT = new Set(['json', 'jsonl', 'csv', 'tsv', 'txt']);
const clampExt = (ext: string): string => (ALLOWED_EXT.has(ext) ? ext : 'txt');

const safe = (toolName: string): string => toolName.replace(/[^a-zA-Z0-9_-]/g, '');

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
