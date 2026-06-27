'use client';

import { diffLines } from 'diff';
import type { IconKind, ToolBadge } from './types';
import { highlightLine } from './highlight';

/** Shared presentational primitives for the tool-call renderers. */

/** Every code/diff body scrolls inside this fixed window (~14 lines) instead of growing unbounded. */
const CODE_MAX_HEIGHT = 280;

export const Chevron = ({ size = 11, className = '' }: { size?: number; className?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`shrink-0 transition-transform ${className}`}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export function ToolIcon({ kind, color }: { kind: IconKind; color: string }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { flex: 'none' as const },
  };
  switch (kind) {
    case 'bash':
      return (
        <svg {...common}>
          <path d="M4 17l6-5-6-5" />
          <path d="M13 19h7" />
        </svg>
      );
    case 'read':
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    case 'edit':
      return (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      );
    case 'write':
      // file-plus — a freshly created file (green stroke, set by the handler's color)
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6" />
          <path d="M12 18v-5" />
          <path d="M9.5 15.5h5" />
        </svg>
      );
    case 'grep':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
      );
    case 'mcp':
    default:
      return (
        <svg {...common}>
          <path d="M9 2v6" />
          <path d="M15 2v6" />
          <path d="M6 8h12v3a6 6 0 0 1-12 0Z" />
          <path d="M12 17v5" />
        </svg>
      );
  }
}

/** An add-toned pill before the badge — e.g. "NEW" on a Write row. */
export function NewPill({ text }: { text: string }) {
  return (
    <span
      className="shrink-0 rounded-[4px] px-1.5 py-px font-mono text-[9px] font-bold"
      style={{ color: 'var(--add)', background: 'var(--add-bg)', border: '1px solid var(--add-gut)' }}
    >
      {text}
    </span>
  );
}

/**
 * Right-aligned row badge: a `+N −N` diffstat (rendered as chip pills), an "N ln" count, or "error".
 * `size` scales the diffstat chips — `group` for the file-change group header, `row` per file.
 */
export function Badge({ badge, size = 'row' }: { badge: ToolBadge; size?: 'group' | 'row' }) {
  if (!badge) return null;
  if (badge.kind === 'error') {
    return (
      <span className="shrink-0 font-mono text-[10px]" style={{ color: 'var(--red)' }}>
        error
      </span>
    );
  }
  if (badge.kind === 'lines') {
    return <span className="shrink-0 font-mono text-[10px] text-faint">{badge.n} ln</span>;
  }
  // diffstat — chip pills; the minus glyph is U+2212, not a hyphen.
  const chip = size === 'group' ? 'text-[10.5px] px-[7px] py-[1.5px] rounded-[5px]' : 'text-[9.5px] px-[5px] py-[0.5px] rounded-[4px]';
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono font-bold tabular-nums tracking-[-0.01em]">
      <span className={chip} style={{ color: 'var(--add)', background: 'var(--add-bg)', border: '1px solid var(--add-gut)' }}>
        +{badge.added}
      </span>
      {badge.removed != null ? (
        <span className={chip} style={{ color: 'var(--del)', background: 'var(--del-bg)', border: '1px solid var(--del-gut)' }}>
          −{badge.removed}
        </span>
      ) : null}
    </span>
  );
}

/** Dark terminal output block — for shell/file/search tool results. Capped + scrolls past ~14 lines. */
export function TerminalBlock({ body }: { body: string }) {
  return (
    <pre
      className="my-[3px] ml-0 overflow-auto whitespace-pre rounded-[7px] px-[11px] py-[9px] font-mono text-[10.5px] leading-[1.8]"
      style={{ background: 'var(--term)', color: 'var(--term-dim)', maxHeight: CODE_MAX_HEIGHT }}
    >
      {body}
    </pre>
  );
}

/** Light panel for structured (MCP) results — optional `input` section + a result/error section. */
export function StructuredPanel({
  input,
  result,
  isError,
}: {
  input?: string;
  result: string;
  isError?: boolean;
}) {
  const body = result || (isError ? '(error)' : '(no output)');
  return (
    <div
      className="my-[3px] space-y-1.5 rounded-[7px] border border-border px-[11px] py-[9px] font-mono text-[11px] leading-relaxed text-dim"
      style={{ background: 'var(--panel)' }}
    >
      {input ? (
        <div>
          <span className="text-faint">input</span>
          <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words">{input}</pre>
        </div>
      ) : null}
      <div>
        <span className="text-faint">{isError ? 'error' : 'result'}</span>
        <pre
          className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words"
          style={isError ? { color: 'var(--red)' } : undefined}
        >
          {body}
        </pre>
      </div>
    </div>
  );
}

/** Drop the trailing empty element a terminal `\n` leaves after split, but keep interior blank lines. */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const NBSP = ' ';

type DiffRow = { key: number; type: 'context' | 'add' | 'del'; oldNo?: number; newNo?: number; code: string };

/** Walk a jsdiff line-diff into numbered rows + the old/new line totals for the hunk header. */
function computeDiffRows(before: string, after: string): { rows: DiffRow[]; oldCount: number; newCount: number } {
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let key = 0;
  for (const part of diffLines(before, after)) {
    const type = part.added ? 'add' : part.removed ? 'del' : 'context';
    for (const code of splitLines(part.value)) {
      if (type === 'add') rows.push({ key: key++, type, newNo: newNo++, code });
      else if (type === 'del') rows.push({ key: key++, type, oldNo: oldNo++, code });
      else rows.push({ key: key++, type, oldNo: oldNo++, newNo: newNo++, code });
    }
  }
  return { rows, oldCount: oldNo - 1, newCount: newNo - 1 };
}

/** A syntax-highlighted code span for the dark frame. `dim` softens context/non-changed lines. */
function CodeText({ code, lang, dim = false }: { code: string; lang: string | null; dim?: boolean }) {
  return (
    <span
      className="hljs whitespace-pre pr-3"
      style={{ color: dim ? 'var(--term-dim)' : 'var(--term-fg)' }}
      dangerouslySetInnerHTML={{ __html: highlightLine(code, lang) }}
    />
  );
}

/** One diff line: old-no gutter · new-no gutter · sign · highlighted code, tinted by row type (dark). */
function DiffLine({ row, lang }: { row: DiffRow; lang: string | null }) {
  const isAdd = row.type === 'add';
  const isDel = row.type === 'del';
  const rowBg = isAdd ? 'var(--term-add-bg)' : isDel ? 'var(--term-del-bg)' : 'transparent';
  const gutBg = isAdd ? 'var(--term-add-gut)' : isDel ? 'var(--term-del-gut)' : 'transparent';
  return (
    <div className="flex" style={{ background: rowBg }}>
      <span
        className="shrink-0 text-right tabular-nums"
        style={{ width: 28, padding: '0 7px', background: gutBg, color: isDel ? 'var(--term-del)' : 'var(--term-dim)', opacity: isDel ? 0.95 : 0.6 }}
      >
        {row.oldNo ?? NBSP}
      </span>
      <span
        className="shrink-0 text-right tabular-nums"
        style={{ width: 28, padding: '0 7px', background: gutBg, color: isAdd ? 'var(--term-add)' : 'var(--term-dim)', opacity: isAdd ? 0.95 : 0.6 }}
      >
        {row.newNo ?? NBSP}
      </span>
      <span className="shrink-0 text-center font-bold" style={{ width: 16, color: isAdd ? 'var(--term-add)' : isDel ? 'var(--term-del)' : 'var(--term-dim)' }}>
        {isAdd ? '+' : isDel ? '−' : NBSP}
      </span>
      <CodeText code={row.code} lang={lang} dim={row.type === 'context'} />
    </div>
  );
}

/**
 * A unified line-diff view, computed from `before`/`after` with jsdiff — renders the body of an Edit
 * tool row. Dark code frame (like the Read/terminal block) with a purple `@@` hunk header, syntax
 * highlighting via `lang`, and a fixed ~14-line ({@link CODE_MAX_HEIGHT}) scroll window so a large edit
 * stays compact. Line numbers are relative to the edit fragment (1-based) — the tool input carries only
 * the changed snippet, not its file offset.
 */
export function DiffView({ before, after, lang = null }: { before: string; after: string; lang?: string | null }) {
  const { rows, oldCount, newCount } = computeDiffRows(before, after);
  return (
    <div className="my-[3px] overflow-hidden rounded-[7px]" style={{ background: 'var(--term)', border: '1px solid var(--term-border)' }}>
      <div
        className="flex items-center gap-[7px] px-[11px] py-[5px] font-mono text-[10px]"
        style={{ background: 'var(--term-strip)', borderBottom: '1px solid var(--term-border)', color: 'var(--term-dim)' }}
      >
        <span style={{ color: 'var(--term-purple)' }}>
          @@ -1,{oldCount} +1,{newCount} @@
        </span>
      </div>
      <div className="overflow-auto py-[6px] font-mono text-[11px]" style={{ lineHeight: 1.75, maxHeight: CODE_MAX_HEIGHT }}>
        {rows.map((r) => (
          <DiffLine key={r.key} row={r} lang={lang} />
        ))}
      </div>
    </div>
  );
}

/**
 * A created-file listing — the body of a Write tool row. Dark frame, single right-aligned gutter, no
 * `+/−` signs (the green left border conveys "new"), syntax highlighting via `lang`, same scroll window
 * as {@link DiffView}.
 */
export function WriteFileView({ content, lang = null }: { content: string; lang?: string | null }) {
  const lines = splitLines(content);
  return (
    <div
      className="my-[3px] overflow-hidden rounded-[7px]"
      style={{ background: 'var(--term)', border: '1px solid var(--term-border)', borderLeft: '3px solid var(--term-add)' }}
    >
      <div className="overflow-auto py-2 font-mono text-[11px]" style={{ lineHeight: 1.75, maxHeight: CODE_MAX_HEIGHT }}>
        {lines.map((code, i) => (
          <div key={i} className="flex">
            <span className="shrink-0 text-right tabular-nums" style={{ width: 30, padding: '0 8px', color: 'var(--term-dim)', opacity: 0.7 }}>
              {i + 1}
            </span>
            <CodeText code={code} lang={lang} />
          </div>
        ))}
      </div>
    </div>
  );
}
