'use client';

import { diffLines } from 'diff';
import type { DiffHunk, IconKind, ToolBadge } from './types';
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
    case 'todo':
      // checklist with ticks
      return (
        <svg {...common}>
          <path d="M11 6h9" />
          <path d="M11 12h9" />
          <path d="M11 18h9" />
          <path d="M3.5 6.5l1.2 1.2L7 5.5" />
          <path d="M3.5 12.5l1.2 1.2L7 11.5" />
          <path d="M3.5 18.5l1.2 1.2L7 17.5" />
        </svg>
      );
    case 'web':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
        </svg>
      );
    case 'task':
      // sparkle — a spawned sub-agent
      return (
        <svg {...common}>
          <path d="M12 3l1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7L12 3z" />
        </svg>
      );
    case 'plan':
      // clipboard-check
      return (
        <svg {...common}>
          <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
          <path d="M9 5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1H9V5z" />
          <path d="M9 14l2 2 3.5-3.5" />
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

/** An add-toned pill before the badge — e.g. "NEW" on a Write row, or "N NEW" rolled up on a group. */
export function NewPill({ text, size = 'row' }: { text: string; size?: 'group' | 'row' }) {
  const dims = size === 'group' ? 'text-[10.5px] px-[7px] py-[1.5px] rounded-[5px]' : 'text-[9px] px-1.5 py-px rounded-[4px]';
  return (
    <span
      className={`shrink-0 font-mono font-bold ${dims}`}
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
    // Neutral gray pill — e.g. the line count read off a Read row.
    return (
      <span
        className="shrink-0 rounded-[4px] px-[6px] py-[0.5px] font-mono text-[9.5px] font-semibold tabular-nums"
        style={{ color: 'var(--dim)', background: 'var(--surface-3)', border: '1px solid var(--border)' }}
      >
        {badge.n} ln
      </span>
    );
  }
  // diffstat — chip pills; the minus glyph is U+2212, not a hyphen.
  const chip = size === 'group' ? 'text-[10.5px] px-[7px] py-[1.5px] rounded-[5px]' : 'text-[9.5px] px-[5px] py-[0.5px] rounded-[4px]';
  // Suppress a zero-count chip (a pure insertion shows just `+N`, a pure deletion just `−N`), but
  // keep `+0` as a fallback for a genuine no-op edit so the badge is never empty.
  const showDel = badge.removed != null && badge.removed > 0;
  const showAdd = badge.added > 0 || !showDel;
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono font-bold tabular-nums tracking-[-0.01em]">
      {showAdd ? (
        <span className={chip} style={{ color: 'var(--add)', background: 'var(--add-bg)', border: '1px solid var(--add-gut)' }}>
          +{badge.added}
        </span>
      ) : null}
      {showDel ? (
        <span className={chip} style={{ color: 'var(--del)', background: 'var(--del-bg)', border: '1px solid var(--del-gut)' }}>
          −{badge.removed}
        </span>
      ) : null}
    </span>
  );
}

/** A shell prompt line (bash-highlighted) above terminal output — the command as if we'd typed it. */
function CommandPrompt({ command }: { command: string }) {
  const lines = command.replace(/\n$/, '').split('\n');
  return (
    <div className="mb-1.5">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="shrink-0 select-none pr-2" style={{ color: 'var(--term-add)' }}>
            {i === 0 ? '$' : NBSP}
          </span>
          <CodeText code={line} lang="bash" />
        </div>
      ))}
    </div>
  );
}

/**
 * Dark terminal output block — for shell/search tool results. Capped + scrolls past ~14 lines.
 * `chrome` adds a macOS-window title bar (traffic-light dots + optional `label`); `command` prints a
 * bash-highlighted `$` prompt above the output, so the Bash row reads as a real terminal session.
 * Grep/Glob keep the plain block.
 */
export function TerminalBlock({
  body,
  chrome = false,
  label,
  command,
}: {
  body: string;
  chrome?: boolean;
  label?: string;
  command?: string;
}) {
  return (
    <div className="my-[3px] overflow-hidden rounded-[7px]" style={{ background: 'var(--term)', border: '1px solid var(--term-border)' }}>
      {chrome ? (
        <div className="flex items-center gap-[6px] px-[11px] py-[6px]" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: '#ff5f57' }} />
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: '#febc2e' }} />
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: '#28c840' }} />
          <span className="flex-1" />
          {label ? (
            <span className="font-mono text-[10px] lowercase" style={{ color: 'var(--term-dim)' }}>
              {label}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-auto px-[11px] py-[9px] font-mono text-[10.5px] leading-[1.8]" style={{ maxHeight: CODE_MAX_HEIGHT }}>
        {command ? <CommandPrompt command={command} /> : null}
        <pre className="m-0 whitespace-pre" style={{ color: 'var(--term-dim)' }}>
          {body}
        </pre>
      </div>
    </div>
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

/** A renderable diff block: a hunk header line + its numbered rows. */
type DiffBlock = { header: string; rows: DiffRow[] };

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

/** Walk one structured-patch hunk into numbered rows, seeding line numbers from its real file offsets. */
function rowsFromHunk(hunk: DiffHunk, keyBase: number): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  let key = keyBase;
  for (const raw of hunk.lines) {
    const sign = raw[0];
    const code = raw.slice(1);
    if (sign === '+') rows.push({ key: key++, type: 'add', newNo: newNo++, code });
    else if (sign === '-') rows.push({ key: key++, type: 'del', oldNo: oldNo++, code });
    else if (sign === '\\') continue; // "\ No newline at end of file" marker — not a real line
    else rows.push({ key: key++, type: 'context', oldNo: oldNo++, newNo: newNo++, code });
  }
  return rows;
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
 * A unified line-diff view — renders the body of an Edit tool row. Dark code frame (like the
 * Read/terminal block) with a purple `@@` hunk header per hunk, syntax highlighting via `lang`, and a
 * fixed ~14-line ({@link CODE_MAX_HEIGHT}) scroll window so a large edit stays compact.
 *
 * Prefers `hunks` (a structured patch off the tool RESULT) so the gutter shows REAL file line numbers.
 * Falls back to `before`/`after` (the tool INPUT, just the changed snippet) — numbered 1-based relative
 * to the fragment, since the input carries no file offset.
 */
export function DiffView({
  hunks,
  before,
  after,
  lang = null,
}: {
  hunks?: DiffHunk[];
  before?: string;
  after?: string;
  lang?: string | null;
}) {
  const blocks: DiffBlock[] =
    hunks && hunks.length
      ? hunks.map((h, i) => ({
          header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
          rows: rowsFromHunk(h, i * 100_000),
        }))
      : (() => {
          const { rows, oldCount, newCount } = computeDiffRows(before ?? '', after ?? '');
          return [{ header: `@@ -1,${oldCount} +1,${newCount} @@`, rows }];
        })();
  return (
    <div className="my-[3px] overflow-hidden rounded-[7px]" style={{ background: 'var(--term)', border: '1px solid var(--term-border)' }}>
      <div className="overflow-auto py-[6px] font-mono text-[11px]" style={{ lineHeight: 1.75, maxHeight: CODE_MAX_HEIGHT }}>
        {blocks.map((block, bi) => (
          <div key={bi}>
            <div
              className="flex items-center gap-[7px] px-[11px] py-[3px] font-mono text-[10px]"
              style={{ color: 'var(--term-purple)' }}
            >
              {block.header}
            </div>
            {block.rows.map((r) => (
              <DiffLine key={r.key} row={r} lang={lang} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A numbered code listing on the dark frame: right-aligned line-number gutter + highlighted code. */
function CodeListing({
  rows,
  lang,
  leftAccent = false,
}: {
  rows: Array<{ no: number | string; code: string }>;
  lang: string | null;
  leftAccent?: boolean;
}) {
  // Size the gutter to the widest line number so big-file numbers don't wrap or clip.
  const widest = rows.reduce((m, r) => Math.max(m, String(r.no).length), 0);
  const gutter = Math.max(30, widest * 7 + 16);
  return (
    <div
      className="my-[3px] overflow-hidden rounded-[7px]"
      style={{
        background: 'var(--term)',
        border: '1px solid var(--term-border)',
        ...(leftAccent ? { borderLeft: '3px solid var(--term-add)' } : {}),
      }}
    >
      <div className="overflow-auto py-2 font-mono text-[11px]" style={{ lineHeight: 1.75, maxHeight: CODE_MAX_HEIGHT }}>
        {rows.map((r, i) => (
          <div key={i} className="flex">
            <span className="shrink-0 text-right tabular-nums" style={{ width: gutter, padding: '0 8px', color: 'var(--term-dim)', opacity: 0.7 }}>
              {r.no === '' ? NBSP : r.no}
            </span>
            <CodeText code={r.code} lang={lang} />
          </div>
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
  const rows = splitLines(content).map((code, i) => ({ no: i + 1, code }));
  return <CodeListing rows={rows} lang={lang} leftAccent />;
}

/**
 * A read-file listing — the body of a Read tool row. Claude Code returns the file as `<n>\t<line>`
 * lines; we split off that gutter so the code can be syntax-highlighted and the real (file) line
 * numbers are preserved. Non-numbered lines (e.g. a trailing truncation note) keep a blank gutter.
 */
export function ReadFileView({ result, lang = null }: { result: string; lang?: string | null }) {
  const rows = splitLines(result).map((line) => {
    const tab = line.indexOf('\t');
    if (tab > 0 && /^\d+$/.test(line.slice(0, tab))) return { no: line.slice(0, tab), code: line.slice(tab + 1) };
    return { no: '' as const, code: line };
  });
  return <CodeListing rows={rows} lang={lang} />;
}

/**
 * A grep match listing — the body of a Grep tool row in `-n` content mode. Ripgrep prints `<n>:<match>`
 * (and `<n>-<context>`) when one file is searched; we split that gutter off and highlight the match
 * with the file's `lang`. Only used for the single-file numbered case (the handler detects it);
 * multi-file / files-with-matches output stays a plain terminal block.
 */
export function GrepView({ result, lang = null }: { result: string; lang?: string | null }) {
  const rows = splitLines(result).map((line) => {
    const m = /^(\d+)[:-](.*)$/.exec(line);
    return m ? { no: m[1], code: m[2] } : { no: '' as const, code: line };
  });
  return <CodeListing rows={rows} lang={lang} />;
}

/**
 * A path listing — the body of a Glob tool row. Glob returns matching file paths (not code, so nothing
 * to syntax-highlight); we dim the directory and keep the filename bright so the matches scan quickly.
 */
export function PathListView({ result }: { result: string }) {
  const lines = splitLines(result);
  return (
    <div className="my-[3px] overflow-hidden rounded-[7px]" style={{ background: 'var(--term)', border: '1px solid var(--term-border)' }}>
      <div className="overflow-auto px-[11px] py-2 font-mono text-[11px]" style={{ lineHeight: 1.75, maxHeight: CODE_MAX_HEIGHT }}>
        {lines.map((line, i) => {
          const cut = line.lastIndexOf('/');
          const dir = cut >= 0 ? line.slice(0, cut + 1) : '';
          const base = cut >= 0 ? line.slice(cut + 1) : line;
          return (
            <div key={i} className="whitespace-pre">
              {dir ? <span style={{ color: 'var(--term-dim)' }}>{dir}</span> : null}
              <span style={{ color: 'var(--term-fg)' }}>{base || NBSP}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
