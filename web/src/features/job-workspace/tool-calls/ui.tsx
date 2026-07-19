'use client';

import { useMemo, useState } from 'react';
import { CopyButton, TerminalChromeBar, WrapButton } from '../components/terminal/terminal-chrome';
import { computeDiffRows, rowsFromHunk, splitLines, type DiffRow } from './diff-rows';
import { renderTokenLine, useHighlightTokens, type ThemedToken } from './highlight';
import type { DiffHunk, IconKind, ToolBadge } from './types';

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
  const dims =
    size === 'group'
      ? 'text-[10.5px] px-1.75 py-[1.5px] rounded-[5px]'
      : 'text-[9px] px-1.5 py-px rounded-[4px]';
  return (
    <span
      className={`shrink-0 font-mono font-bold ${dims}`}
      style={{
        color: 'var(--add)',
        background: 'var(--add-bg)',
        border: '1px solid var(--add-gut)',
      }}
    >
      {text}
    </span>
  );
}

/** Marks a tool row whose tool triggered a JIT PostToolUse additionalContext injection (svc-nudge /
 * github-fetch-guard / install-awareness) — an info-toned pill distinct from NewPill's add-green. */
export function JitPill({ count }: { count: number }) {
  return (
    <span
      className="shrink-0 font-mono font-bold text-[9px] px-1.5 py-px rounded-[4px]"
      style={{
        color: 'var(--blue)',
        background: 'var(--blue-soft)',
        border: '1px solid var(--blue)',
      }}
    >
      {count}
    </span>
  );
}

/** Expanded-body panel listing each JIT injection that fired on this tool call: a rule label + the
 * verbatim injected text in a monospace block. Rendered AFTER the tool's own input/result body, so the
 * tool card (e.g. the Bash terminal chrome) reads first and the injected context follows it. */
export function JitContextPanel({ items }: { items: Array<{ rule: string; text: string }> }) {
  return (
    <div
      className="my-0.75 space-y-2 rounded-[7px] border px-2.75 py-2.25 font-mono text-[11px] leading-relaxed"
      style={{ background: 'var(--blue-soft)', borderColor: 'var(--blue)' }}
    >
      {items.map((it, i) => (
        <div key={i}>
          <span className="font-bold" style={{ color: 'var(--blue)' }}>
            {it.rule}
          </span>
          <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap wrap-break-word text-dim">
            {it.text}
          </pre>
        </div>
      ))}
    </div>
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
  if (badge.kind === 'superseded') {
    return (
      <span
        className="shrink-0 rounded-[4px] px-1.5 py-[0.5px] font-mono text-[9.5px] font-semibold"
        style={{
          color: 'var(--dim)',
          background: 'var(--surface-3)',
          border: '1px solid var(--border)',
        }}
      >
        superseded
      </span>
    );
  }
  if (badge.kind === 'lines') {
    // Neutral gray pill — e.g. the line count read off a Read row.
    return (
      <span
        className="shrink-0 rounded-[4px] px-1.5 py-[0.5px] font-mono text-[9.5px] font-semibold tabular-nums"
        style={{
          color: 'var(--dim)',
          background: 'var(--surface-3)',
          border: '1px solid var(--border)',
        }}
      >
        {badge.n} ln
      </span>
    );
  }
  // diffstat — chip pills; the minus glyph is U+2212, not a hyphen.
  const chip =
    size === 'group'
      ? 'text-[10.5px] px-1.75 py-[1.5px] rounded-[5px]'
      : 'text-[9.5px] px-1.25 py-[0.5px] rounded-[4px]';
  // Suppress a zero-count chip (a pure insertion shows just `+N`, a pure deletion just `−N`), but
  // keep `+0` as a fallback for a genuine no-op edit so the badge is never empty.
  const showDel = badge.removed != null && badge.removed > 0;
  const showAdd = badge.added > 0 || !showDel;
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono font-bold tabular-nums tracking-[-0.01em]">
      {showAdd ? (
        <span
          className={chip}
          style={{
            color: 'var(--add)',
            background: 'var(--add-bg)',
            border: '1px solid var(--add-gut)',
          }}
        >
          +{badge.added}
        </span>
      ) : null}
      {showDel ? (
        <span
          className={chip}
          style={{
            color: 'var(--del)',
            background: 'var(--del-bg)',
            border: '1px solid var(--del-gut)',
          }}
        >
          −{badge.removed}
        </span>
      ) : null}
    </span>
  );
}

/** A shell prompt line (bash-highlighted) above terminal output — the command as if we'd typed it. */
function CommandPrompt({ command }: { command: string }) {
  const lines = command.replace(/\n$/, '').split('\n');
  const lineTokens = useHighlightTokens(lines.join('\n'), 'bash', true);
  return (
    <div className="mb-1.5">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="shrink-0 select-none pr-2" style={{ color: 'var(--term-add)' }}>
            {i === 0 ? '$' : NBSP}
          </span>
          <CodeText tokens={lineTokens?.[i]} code={line} />
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
  const [wrapped, setWrapped] = useState(false);
  return (
    <div
      className="my-0.75 overflow-hidden rounded-[7px]"
      style={{
        background: 'var(--term)',
        border: '1px solid var(--term-border)',
      }}
    >
      {chrome ? (
        <TerminalChromeBar
          label={label}
          actions={
            <>
              <WrapButton wrapped={wrapped} onToggle={() => setWrapped((w) => !w)} />
              <CopyButton text={body} />
            </>
          }
        />
      ) : null}
      <div
        className="overflow-auto px-2.75 py-2.25 font-mono text-[10.5px] leading-[1.8]"
        style={{ maxHeight: CODE_MAX_HEIGHT }}
      >
        {command ? <CommandPrompt command={command} /> : null}
        <pre
          className={`m-0 ${wrapped ? 'whitespace-pre-wrap wrap-break-word' : 'whitespace-pre'}`}
          style={{ color: 'var(--term-dim)' }}
        >
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
  superseded,
}: {
  input?: string;
  result: string;
  isError?: boolean;
  superseded?: boolean;
}) {
  const body = result || (isError ? '(error)' : '(no output)');
  const red = isError && !superseded;
  return (
    <div
      className="my-0.75 space-y-1.5 rounded-[7px] border border-border px-2.75 py-2.25 font-mono text-[11px] leading-relaxed text-dim"
      style={{ background: 'var(--panel)' }}
    >
      {superseded ? (
        <div className="text-faint text-[10.5px]">Cancelled to deliver your newer message</div>
      ) : null}
      {input ? (
        <div>
          <span className="text-faint">input</span>
          <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap wrap-break-word">{input}</pre>
        </div>
      ) : null}
      <div>
        <span className="text-faint">{red ? 'error' : 'result'}</span>
        <pre
          className="mt-0.5 overflow-x-auto whitespace-pre-wrap wrap-break-word"
          style={red ? { color: 'var(--red)' } : undefined}
        >
          {body}
        </pre>
      </div>
    </div>
  );
}

const NBSP = ' ';

/** A renderable diff block: a hunk header line + its numbered rows. */
type DiffBlock = { header: string; rows: DiffRow[] };

/**
 * A syntax-highlighted code span for the dark frame. Renders one line's Shiki `tokens` (or plain
 * escaped `code` while the highlighter loads). `dim` softens context/non-changed lines via opacity —
 * with per-token inline colors a wrapper `color` would only tint the plain fallback, so opacity is how
 * the softened look is preserved.
 */
function CodeText({
  tokens,
  code,
  dim = false,
}: {
  tokens: ThemedToken[] | null | undefined;
  code: string;
  dim?: boolean;
}) {
  return (
    <span
      className="whitespace-pre pr-3"
      style={{ color: 'var(--term-fg)', opacity: dim ? 0.72 : 1 }}
    >
      {renderTokenLine(tokens, code)}
    </span>
  );
}

/** One diff line: old-no gutter · new-no gutter · sign · highlighted code, tinted by row type (dark). */
function DiffLine({ row, tokens }: { row: DiffRow; tokens: ThemedToken[] | null | undefined }) {
  const isAdd = row.type === 'add';
  const isDel = row.type === 'del';
  const rowBg = isAdd ? 'var(--term-add-bg)' : isDel ? 'var(--term-del-bg)' : 'transparent';
  const gutBg = isAdd ? 'var(--term-add-gut)' : isDel ? 'var(--term-del-gut)' : 'transparent';
  return (
    <div className="flex" style={{ background: rowBg }}>
      <span
        className="shrink-0 text-right tabular-nums"
        style={{
          width: 28,
          padding: '0 7px',
          background: gutBg,
          color: isDel ? 'var(--term-del)' : 'var(--term-dim)',
          opacity: isDel ? 0.95 : 0.6,
        }}
      >
        {row.oldNo ?? NBSP}
      </span>
      <span
        className="shrink-0 text-right tabular-nums"
        style={{
          width: 28,
          padding: '0 7px',
          background: gutBg,
          color: isAdd ? 'var(--term-add)' : 'var(--term-dim)',
          opacity: isAdd ? 0.95 : 0.6,
        }}
      >
        {row.newNo ?? NBSP}
      </span>
      <span
        className="shrink-0 text-center font-bold"
        style={{
          width: 16,
          color: isAdd ? 'var(--term-add)' : isDel ? 'var(--term-del)' : 'var(--term-dim)',
        }}
      >
        {isAdd ? '+' : isDel ? '−' : NBSP}
      </span>
      <CodeText tokens={tokens} code={row.code} dim={row.type === 'context'} />
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
  // Diff rows are non-contiguous (interleaved add/del across hunks) → tokenize each line in isolation
  // and index by flat position across all blocks (header rows aren't in `allRows`, so they don't count).
  const allRows = blocks.flatMap((b) => b.rows);
  const lineTokens = useHighlightTokens(allRows.map((r) => r.code).join('\n'), lang, false);
  let flatIndex = 0;
  return (
    <div
      className="my-0.75 overflow-hidden rounded-[7px]"
      style={{
        background: 'var(--term)',
        border: '1px solid var(--term-border)',
      }}
    >
      <div
        className="overflow-auto py-1.5 font-mono text-[11px]"
        style={{ lineHeight: 1.75, maxHeight: CODE_MAX_HEIGHT }}
      >
        {blocks.map((block, bi) => (
          <div key={bi}>
            <div
              className="flex items-center gap-1.75 px-2.75 py-0.75 font-mono text-[10px]"
              style={{ color: 'var(--term-purple)' }}
            >
              {block.header}
            </div>
            {block.rows.map((r) => (
              <DiffLine key={r.key} row={r} tokens={lineTokens?.[flatIndex++]} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A numbered code listing on the dark frame: right-aligned line-number gutter + highlighted code. */
export function CodeListing({
  rows,
  lang,
  leftAccent = false,
  activeNos,
  maxHeight = CODE_MAX_HEIGHT,
  whole = false,
  flush = false,
}: {
  rows: Array<{ no: number | string; code: string }>;
  lang: string | null;
  leftAccent?: boolean;
  /** Line numbers to highlight with a band background (the referenced `:line`/`:range`). */
  activeNos?: ReadonlySet<number>;
  /** Scroll-window cap; pass `"100%"` to fill a taller container (the FilePane). Defaults to CODE_MAX_HEIGHT. */
  maxHeight?: number | string;
  /** Tokenize the rows as one contiguous file (preserves cross-line context) vs each line in isolation. */
  whole?: boolean;
  /** Full-bleed: drop the rounded frame/border/margin and fill the parent's height (the FilePane full-screen viewer). */
  flush?: boolean;
}) {
  // Rows are 1:1 with source lines (each `r.code` is one line, no embedded `\n`), so `lineTokens[i]`
  // aligns to `rows[i]` for both whole-file and per-line tokenization.
  const text = useMemo(() => rows.map((r) => r.code).join('\n'), [rows]);
  const lineTokens = useHighlightTokens(text, lang, whole);
  // Size the gutter to the widest line number so big-file numbers don't wrap or clip.
  const widest = rows.reduce((m, r) => Math.max(m, String(r.no).length), 0);
  const gutter = Math.max(30, widest * 7 + 16);
  return (
    <div
      className={flush ? 'h-full overflow-hidden' : 'my-0.75 overflow-hidden rounded-[7px]'}
      style={{
        background: 'var(--term)',
        ...(flush ? {} : { border: '1px solid var(--term-border)' }),
        ...(leftAccent ? { borderLeft: '3px solid var(--term-add)' } : {}),
      }}
    >
      <div
        className={`overflow-auto py-2 font-mono text-[11px]${flush ? ' h-full' : ''}`}
        style={{ lineHeight: 1.75, maxHeight }}
      >
        {rows.map((r, i) => {
          const active = activeNos != null && typeof r.no === 'number' && activeNos.has(r.no);
          return (
            <div
              key={i}
              data-line={r.no}
              className="flex"
              style={
                active
                  ? {
                      background: 'color-mix(in srgb, var(--blue) 13%, transparent)',
                    }
                  : undefined
              }
            >
              <span
                className="shrink-0 text-right tabular-nums"
                style={{
                  width: gutter,
                  padding: '0 8px',
                  color: 'var(--term-dim)',
                  opacity: 0.7,
                }}
              >
                {r.no === '' ? NBSP : r.no}
              </span>
              <CodeText tokens={lineTokens?.[i]} code={r.code} />
            </div>
          );
        })}
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
  return <CodeListing rows={rows} lang={lang} leftAccent whole />;
}

/**
 * A read-file listing — the body of a Read tool row. Claude Code returns the file as `<n>\t<line>`
 * lines; we split off that gutter so the code can be syntax-highlighted and the real (file) line
 * numbers are preserved. Non-numbered lines (e.g. a trailing truncation note) keep a blank gutter.
 */
export function ReadFileView({ result, lang = null }: { result: string; lang?: string | null }) {
  const rows = splitLines(result).map((line) => {
    const tab = line.indexOf('\t');
    if (tab > 0 && /^\d+$/.test(line.slice(0, tab)))
      return { no: line.slice(0, tab), code: line.slice(tab + 1) };
    return { no: '' as const, code: line };
  });
  return <CodeListing rows={rows} lang={lang} whole />;
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
    <div
      className="my-0.75 overflow-hidden rounded-[7px]"
      style={{
        background: 'var(--term)',
        border: '1px solid var(--term-border)',
      }}
    >
      <div
        className="overflow-auto px-2.75 py-2 font-mono text-[11px]"
        style={{ lineHeight: 1.75, maxHeight: CODE_MAX_HEIGHT }}
      >
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
