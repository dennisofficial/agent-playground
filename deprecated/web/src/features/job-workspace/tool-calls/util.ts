import { BRIDGE_SERVER_NAME } from './constants';

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
}

export function basename(path: string): string {
  const clean = path.split('?')[0].replace(/\/+$/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1] || clean;
}

export function mcpName(name: string): string {
  const segs = name.split('__').filter(Boolean);
  return segs[segs.length - 1] || name;
}

/**
 * Normalize a bridge tool's input for display. Host tools are registered with their real, flat
 * per-field shape (see `engine-entrypoint.ts` / `host-tool-schemas.ts`), so bridge inputs arrive with
 * their fields at the top level — the same as native tools (Edit/Bash/…). The `args` unwrap is a
 * defensive fallback for any legacy transcript that still carries an `{ args }` wrapper.
 */
export function argsOf(input: unknown): Record<string, unknown> {
  const rec = asRecord(input);
  return asRecord('args' in rec ? rec.args : rec);
}

export function isBridgeTool(name: string): boolean {
  return name.startsWith(`mcp__${BRIDGE_SERVER_NAME}__`);
}

export function formatPayload(value: unknown): string {
  if (value == null) return '';
  let out: string;
  if (typeof value === 'string') out = value;
  else {
    try {
      out = JSON.stringify(value, null, 2);
    } catch {
      out = String(value);
    }
  }
  return out.length > 4000 ? `${out.slice(0, 4000)}\n… (truncated)` : out;
}

export function resultLineCount(result: unknown): number {
  const s = typeof result === 'string' ? result : '';
  if (!s.trim()) return 0;
  const n = s.replace(/\n$/, '').split('\n').length;
  return n > 1 ? n : 0;
}
