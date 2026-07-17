import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DUMP_SUBDIR,
  DUMP_THRESHOLD_BYTES,
  isDumpEnabled,
  maybeDumpLargeResult,
} from './mcp-hub-dump';

function textResult(text: string, isError?: boolean): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

function bigString(prefix: string, minBytes: number): string {
  const filler = 'x'.repeat(Math.max(0, minBytes - prefix.length));
  return prefix + filler;
}

function withTempPlayground<T>(fn: (playgroundDir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-hub-dump-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('isDumpEnabled', () => {
  it('is always true (scope gate reserved for future narrowing)', () => {
    expect(isDumpEnabled('anything')).toBe(true);
    expect(isDumpEnabled('')).toBe(true);
  });
});

describe('maybeDumpLargeResult', () => {
  it('returns a small result unchanged, no file written', () => {
    withTempPlayground((playgroundDir) => {
      const result = textResult('a small payload');
      const out = maybeDumpLargeResult(
        { serverName: 's', toolName: 'tool', args: undefined, result },
        { playgroundDir },
      );
      expect(out).toBe(result);
    });
  });

  it('dumps a large reader csv envelope to a clean .csv file', () => {
    withTempPlayground((playgroundDir) => {
      const csvText = ['id,name', ...Array.from({ length: 3000 }, (_, i) => `${i},row-${i}`)].join(
        '\n',
      );
      expect(Buffer.byteLength(csvText, 'utf8')).toBeGreaterThan(DUMP_THRESHOLD_BYTES);
      const envelope = JSON.stringify({
        format: 'csv',
        text: csvText,
        rowCount: 3000,
        truncated: false,
      });
      const result = textResult(envelope);

      const out = maybeDumpLargeResult(
        { serverName: 's', toolName: 'atlas_query', args: undefined, result },
        { playgroundDir },
      );

      const body = JSON.parse((out.content[0] as { text: string }).text) as {
        dumpedTo: string;
        format: string;
        rowCount: number;
        preview: string;
      };
      expect(body.dumpedTo).toContain(join(playgroundDir, DUMP_SUBDIR) + sep);
      expect(body.format).toBe('csv');
      expect(body.rowCount).toBe(3000);
      expect(body.preview).toContain('id,name');
      expect(body.preview).toContain('row-0');

      const written = readFileSync(body.dumpedTo, 'utf8');
      expect(written).toBe(csvText);
      expect(() => JSON.parse(written)).toThrow();
    });
  });

  it('dumps a large reader json envelope to a .json file containing the rows array', () => {
    withTempPlayground((playgroundDir) => {
      const rows = Array.from({ length: 2000 }, (_, i) => ({
        id: i,
        name: `row-${i}`,
      }));
      const envelope = JSON.stringify({
        format: 'json',
        rows,
        rowCount: rows.length,
      });
      expect(Buffer.byteLength(envelope, 'utf8')).toBeGreaterThan(DUMP_THRESHOLD_BYTES);
      const result = textResult(envelope);

      const out = maybeDumpLargeResult(
        { serverName: 's', toolName: 'atlas_query', args: undefined, result },
        { playgroundDir },
      );

      const body = JSON.parse((out.content[0] as { text: string }).text) as {
        dumpedTo: string;
        format: string;
      };
      expect(body.format).toBe('json');
      const written = JSON.parse(readFileSync(body.dumpedTo, 'utf8'));
      expect(written).toEqual(rows);
    });
  });

  it('dumps large generic JSON (no format field) to a .json file', () => {
    withTempPlayground((playgroundDir) => {
      const schema = {
        tables: Array.from({ length: 1000 }, (_, i) => ({
          table: `t${i}`,
          columns: ['a', 'b', 'c'],
        })),
      };
      const text = JSON.stringify(schema);
      expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(DUMP_THRESHOLD_BYTES);
      const result = textResult(text);

      const out = maybeDumpLargeResult(
        { serverName: 's', toolName: 'get_schema', args: undefined, result },
        { playgroundDir },
      );

      const body = JSON.parse((out.content[0] as { text: string }).text) as {
        dumpedTo: string;
        format: string;
      };
      expect(body.format).toBe('json');
      expect(body.dumpedTo.endsWith('.json')).toBe(true);
      const written = JSON.parse(readFileSync(body.dumpedTo, 'utf8'));
      expect(written).toEqual(schema);
    });
  });

  it('dumps large non-JSON text to a .txt file', () => {
    withTempPlayground((playgroundDir) => {
      const text = bigString('line one\nline two\n', DUMP_THRESHOLD_BYTES + 5_000);
      const result = textResult(text);

      const out = maybeDumpLargeResult(
        { serverName: 's', toolName: 'read_file', args: undefined, result },
        { playgroundDir },
      );

      const body = JSON.parse((out.content[0] as { text: string }).text) as {
        dumpedTo: string;
        format: string;
      };
      expect(body.format).toBe('txt');
      expect(body.dumpedTo.endsWith('.txt')).toBe(true);
      expect(readFileSync(body.dumpedTo, 'utf8')).toBe(text);
    });
  });

  it('passes an errored result through unchanged, even if large', () => {
    withTempPlayground((playgroundDir) => {
      const text = bigString('error: ', DUMP_THRESHOLD_BYTES + 1_000);
      const result = textResult(text, true);
      const out = maybeDumpLargeResult(
        { serverName: 's', toolName: 'tool', args: undefined, result },
        { playgroundDir },
      );
      expect(out).toBe(result);
    });
  });

  it('passes non-text content through unchanged, even if large', () => {
    withTempPlayground((playgroundDir) => {
      const bigText = bigString('t', DUMP_THRESHOLD_BYTES + 1_000);
      const result: CallToolResult = {
        content: [
          { type: 'text', text: bigText },
          { type: 'image', data: 'YmFzZTY0', mimeType: 'image/png' },
        ],
      };
      const out = maybeDumpLargeResult(
        { serverName: 's', toolName: 'screenshot', args: undefined, result },
        { playgroundDir },
      );
      expect(out).toBe(result);
    });
  });

  it('never lets a hostile `format` field escape the dump dir, and clamps toolName path chars', () => {
    withTempPlayground((playgroundDir) => {
      const text = bigString('payload text\n', DUMP_THRESHOLD_BYTES + 2_000);
      const envelope = JSON.stringify({
        format: '../../../../workspace/evil',
        text,
      });
      const result = textResult(envelope);

      const out = maybeDumpLargeResult(
        { serverName: 's', toolName: '../evil/x', args: undefined, result },
        { playgroundDir },
      );

      const body = JSON.parse((out.content[0] as { text: string }).text) as {
        dumpedTo: string;
        format: string;
      };
      // hostile format is not a trusted extension → falls to the generic JSON branch.
      expect(body.format).toBe('json');
      const dumpDir = join(playgroundDir, DUMP_SUBDIR);
      expect(body.dumpedTo.startsWith(dumpDir + sep)).toBe(true);
      expect(body.dumpedTo).not.toContain('..');
      expect(body.dumpedTo).not.toContain('/evil/');
      const filename = body.dumpedTo.slice(dumpDir.length + 1);
      expect(filename.includes('/')).toBe(false);
      expect(filename.includes('..')).toBe(false);
    });
  });

  it('is fail-safe: a throwing writeFile returns the original result without throwing', () => {
    withTempPlayground((playgroundDir) => {
      const text = bigString('payload\n', DUMP_THRESHOLD_BYTES + 1_000);
      const result = textResult(text);
      const out = maybeDumpLargeResult(
        { serverName: 's', toolName: 'tool', args: undefined, result },
        {
          playgroundDir,
          writeFile: () => {
            throw new Error('disk full');
          },
        },
      );
      expect(out).toBe(result);
    });
  });
});
