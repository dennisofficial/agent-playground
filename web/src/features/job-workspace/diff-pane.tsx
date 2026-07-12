"use client";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, MessageSquarePlus, Plus, X } from "lucide-react";
import { useJobDiff } from "@/lib/api/job-queries";
import type { JobRef } from "@/lib/api/job-api";
import type { JobDiffFile } from "@/lib/api/types";
import { rowsFromHunk, type DiffRow } from "./tool-calls/diff-rows";
import {
  langFromPath,
  renderTokenLine,
  useHighlightTokens,
  type ThemedToken,
} from "./tool-calls/highlight";
import { useReviewComments } from "./review-comments";

/**
 * The Changes pane — a full-bleed, GitHub-style unified diff of the job's accumulated worktree change.
 * Each file is a collapsible section with a sticky header over a dark `--term` code surface. Hovering a
 * row exposes a gutter `+`; clicking or drag-selecting a contiguous range opens an inline composer that
 * queues a line-anchored review comment (via `addLineComment`), which rides the normal review-comment
 * pipeline to the composer tray and out to Atlas.
 */

const NBSP = "\u00A0";
const GUTTER = 28;
const SIGN = 16;

type FileRow = DiffRow & { flatIdx: number; hunkIdx: number };

/**
 * Derive a GitHub-style line anchor from a contiguous run of selected diff rows. Each row contributes its
 * own side's display number (a deletion its old-file line, everything else its new-file line); the whole
 * anchor reads 'old' only when every selected row is a deletion, else 'new'.
 */
export function deriveLineAnchor(
  rows: Pick<DiffRow, "type" | "oldNo" | "newNo" | "code">[],
): { side: "old" | "new"; start: number; end: number; code: string } | null {
  if (rows.length === 0) return null;
  const displayNo = (r: Pick<DiffRow, "type" | "oldNo" | "newNo">) =>
    r.type === "del" ? r.oldNo! : r.newNo!;
  const nums = rows.map(displayNo);
  return {
    side: rows.every((r) => r.type === "del") ? "old" : "new",
    start: Math.min(...nums),
    end: Math.max(...nums),
    code: rows.map((r) => r.code).join("\n"),
  };
}

export function DiffPane({ jobRef }: { jobRef: JobRef }) {
  const { data, isLoading, error } = useJobDiff(jobRef, true);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (isLoading) {
    return <div className="px-8 py-7 text-[13px] text-faint">Loading diff…</div>;
  }
  if (error || !data || data.files.length === 0) {
    return (
      <div className="px-8 py-7 text-[13px] text-faint">
        No changes yet — this job hasn&rsquo;t modified any tracked files.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {data.truncated ? (
        <div className="border-b border-border bg-surface-2 px-5 py-2 font-mono text-[11px] text-dim">
          Diff truncated — open the PR to see everything.
        </div>
      ) : null}
      {data.files.map((file) => (
        <DiffFileSection
          key={file.oldPath ? `${file.oldPath}→${file.path}` : file.path}
          file={file}
          collapsed={collapsed.has(file.path)}
          onToggleCollapse={() => toggleCollapse(file.path)}
        />
      ))}
    </div>
  );
}

function DiffFileSection({
  file,
  collapsed,
  onToggleCollapse,
}: {
  file: JobDiffFile;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const { addLineComment } = useReviewComments();
  const sectionRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [selection, setSelection] = useState<{
    anchorIdx: number;
    headIdx: number;
  } | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Rows per hunk, each tagged with a running flat index so a contiguous selection is a plain index range
  // and syntax tokens (one highlight pass over the whole file) can be looked up by that same index.
  const hunks = useMemo(() => {
    let flat = 0;
    return file.hunks.map((hunk, hi) => {
      const rows: FileRow[] = rowsFromHunk(hunk, hi * 100_000).map((r) => ({
        ...r,
        flatIdx: flat++,
        hunkIdx: hi,
      }));
      return { hunk, hi, rows };
    });
  }, [file]);
  const flatRows = useMemo(() => hunks.flatMap((h) => h.rows), [hunks]);
  const lang = useMemo(() => langFromPath(file.path), [file.path]);
  const lineTokens = useHighlightTokens(
    flatRows.map((r) => r.code).join("\n"),
    lang,
    false,
  );

  const range = selection
    ? {
        lo: Math.min(selection.anchorIdx, selection.headIdx),
        hi: Math.max(selection.anchorIdx, selection.headIdx),
      }
    : null;

  // Clicking outside the section (or Escape) drops the in-progress selection + its composer.
  useEffect(() => {
    if (!selection) return;
    const onPointerDown = (e: PointerEvent) => {
      if (sectionRef.current && !sectionRef.current.contains(e.target as Node))
        setSelection(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelection(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [selection]);

  const beginSelect = useCallback((idx: number, shift: boolean) => {
    setSelection((prev) =>
      shift && prev
        ? { anchorIdx: prev.anchorIdx, headIdx: idx }
        : { anchorIdx: idx, headIdx: idx },
    );
    if (shift) return;
    // A plain press starts a drag: extend `head` as the pointer moves over rows, until mouseup.
    draggingRef.current = true;
    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mouseup", onUp);
  }, []);

  const onRowEnter = useCallback(
    (idx: number) => {
      setHoveredIdx(idx);
      if (draggingRef.current)
        setSelection((prev) => {
          if (!prev) return prev;
          // Keep the drag-selection contiguous: only extend into rows that share the
          // anchor row's hunk, so a drag that crosses a hunk-header divider doesn't
          // fabricate a range over the elided region between two hunks.
          if (flatRows[idx]?.hunkIdx !== flatRows[prev.anchorIdx]?.hunkIdx)
            return prev;
          return { ...prev, headIdx: idx };
        });
    },
    [flatRows],
  );

  const selectedRows = range ? flatRows.slice(range.lo, range.hi + 1) : [];
  const anchor = deriveLineAnchor(selectedRows);

  const submitComment = useCallback(
    (note: string) => {
      if (!anchor) return;
      addLineComment({
        path: file.path,
        side: anchor.side,
        start: anchor.start,
        end: anchor.end,
        code: anchor.code,
        note,
      });
      setSelection(null);
    },
    [anchor, addLineComment, file.path],
  );

  const headerPath =
    file.status === "renamed" && file.oldPath
      ? `${file.oldPath} → ${file.path}`
      : file.path;

  return (
    <div
      ref={sectionRef}
      className="border-t border-term-border first:border-t-0"
    >
      <button
        type="button"
        onClick={onToggleCollapse}
        className="sticky top-0 z-10 flex w-full items-center gap-2 px-5 py-2.5 text-left"
        style={{
          background: "var(--surface-2)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <ChevronDown
          size={13}
          strokeWidth={2.4}
          className="flex-none text-dim transition-transform"
          style={collapsed ? { transform: "rotate(-90deg)" } : undefined}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text">
          {headerPath}
        </span>
        {file.additions > 0 ? (
          <span
            className="flex-none rounded-[4px] px-1.5 py-[1.5px] font-mono text-[10px] font-semibold"
            style={{ color: "var(--add)", background: "var(--add-bg)" }}
          >
            +{file.additions}
          </span>
        ) : null}
        {file.deletions > 0 ? (
          <span
            className="flex-none rounded-[4px] px-1.5 py-[1.5px] font-mono text-[10px] font-semibold"
            style={{ color: "var(--del)", background: "var(--del-bg)" }}
          >
            −{file.deletions}
          </span>
        ) : null}
        <span
          className="flex-none rounded-[4px] px-1.5 py-[1.5px] font-mono text-[9px] font-semibold tracking-[0.04em] uppercase"
          style={{ color: "var(--dim)", background: "var(--surface-3)" }}
        >
          {file.status}
        </span>
      </button>

      {collapsed ? null : (
        <div
          className="font-mono text-[11px]"
          style={{ background: "var(--term)", lineHeight: 1.75, padding: "8px 20px" }}
        >
          {file.binary ? (
            <div className="py-1 text-term-dim" style={{ color: "var(--term-dim)" }}>
              Binary file
            </div>
          ) : file.hunks.length === 0 ? (
            <div className="py-1" style={{ color: "var(--term-dim)" }}>
              Diff hidden — file too large
            </div>
          ) : (
            hunks.map(({ hunk, hi, rows }) => (
              <div key={hi}>
                <div
                  className="flex items-center py-1 text-[10px]"
                  style={{ color: "var(--term-purple)" }}
                >
                  @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},
                  {hunk.newLines} @@
                </div>
                {rows.map((r) => {
                  const selected =
                    range != null && r.flatIdx >= range.lo && r.flatIdx <= range.hi;
                  return (
                    <Fragment key={r.key}>
                      <DiffRowLine
                        row={r}
                        tokens={lineTokens?.[r.flatIdx]}
                        selected={selected}
                        hovered={hoveredIdx === r.flatIdx && !selected}
                        onMouseDownRow={(shift) => beginSelect(r.flatIdx, shift)}
                        onMouseEnterRow={() => onRowEnter(r.flatIdx)}
                        onMouseLeaveRow={() =>
                          setHoveredIdx((h) => (h === r.flatIdx ? null : h))
                        }
                        onAdd={() => beginSelect(r.flatIdx, false)}
                      />
                      {range != null && r.flatIdx === range.hi && anchor ? (
                        <InlineComposer
                          label={`${file.path}:${anchor.start}-${anchor.end}`}
                          onAdd={submitComment}
                          onCancel={() => setSelection(null)}
                        />
                      ) : null}
                    </Fragment>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function DiffRowLine({
  row,
  tokens,
  selected,
  hovered,
  onMouseDownRow,
  onMouseEnterRow,
  onMouseLeaveRow,
  onAdd,
}: {
  row: FileRow;
  tokens: ThemedToken[] | null | undefined;
  selected: boolean;
  hovered: boolean;
  onMouseDownRow: (shift: boolean) => void;
  onMouseEnterRow: () => void;
  onMouseLeaveRow: () => void;
  onAdd: () => void;
}) {
  const isAdd = row.type === "add";
  const isDel = row.type === "del";
  const baseBg = isAdd
    ? "var(--term-add-bg)"
    : isDel
      ? "var(--term-del-bg)"
      : "transparent";
  const gutBg = isAdd
    ? "var(--term-add-gut)"
    : isDel
      ? "var(--term-del-gut)"
      : "transparent";
  const rowStyle = selected
    ? {
        background: "color-mix(in srgb, var(--accent) 16%, var(--term))",
        boxShadow: "inset 3px 0 0 var(--accent)",
      }
    : { background: hovered ? "rgba(255,255,255,0.035)" : baseBg };
  return (
    <div
      className="relative flex cursor-pointer select-none"
      style={rowStyle}
      onMouseDown={(e) => {
        e.preventDefault();
        onMouseDownRow(e.shiftKey);
      }}
      onMouseEnter={onMouseEnterRow}
      onMouseLeave={onMouseLeaveRow}
    >
      {hovered ? (
        <button
          type="button"
          aria-label="Add a comment on this line"
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onAdd();
          }}
          className="absolute z-[3] flex items-center justify-center rounded-full text-white"
          style={{
            left: 4,
            top: "50%",
            transform: "translateY(-50%)",
            width: 16,
            height: 16,
            background: "var(--accent)",
            boxShadow: "0 2px 6px rgba(0,0,0,.35)",
          }}
        >
          <Plus size={10} strokeWidth={3} />
        </button>
      ) : null}
      <span
        className="shrink-0 text-right tabular-nums"
        style={{
          width: GUTTER,
          padding: "0 7px",
          background: gutBg,
          color: isDel ? "var(--term-del)" : "var(--term-dim)",
          opacity: isDel ? 0.95 : 0.6,
        }}
      >
        {row.oldNo ?? NBSP}
      </span>
      <span
        className="shrink-0 text-right tabular-nums"
        style={{
          width: GUTTER,
          padding: "0 7px",
          background: gutBg,
          color: isAdd ? "var(--term-add)" : "var(--term-dim)",
          opacity: isAdd ? 0.95 : 0.6,
        }}
      >
        {row.newNo ?? NBSP}
      </span>
      <span
        className="shrink-0 text-center font-bold"
        style={{
          width: SIGN,
          color: isAdd
            ? "var(--term-add)"
            : isDel
              ? "var(--term-del)"
              : "var(--term-dim)",
        }}
      >
        {isAdd ? "+" : isDel ? "−" : NBSP}
      </span>
      <span
        className="whitespace-pre pr-3"
        style={{
          color: "var(--term-fg)",
          opacity: row.type === "context" ? 0.72 : 1,
        }}
      >
        {renderTokenLine(tokens, row.code)}
      </span>
    </div>
  );
}

function InlineComposer({
  label,
  onAdd,
  onCancel,
}: {
  label: string;
  onAdd: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  return (
    <div
      className="my-1 rounded-[13px] border border-border-2 bg-panel p-3"
      style={{ boxShadow: "var(--shadow-menu)" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-1.5">
        <MessageSquarePlus size={11} className="text-accent" strokeWidth={2} />
        <span className="font-mono text-[8px] font-semibold tracking-[0.07em] text-accent-2 uppercase">
          Comment on selection
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="p-0.5 text-faint"
        >
          <X size={13} />
        </button>
      </div>
      <div className="mb-2.5 overflow-hidden rounded-md bg-accent-soft px-2 py-1.5 font-mono text-[10.5px] text-accent-2">
        {label}
      </div>
      <textarea
        ref={textareaRef}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onAdd(note);
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
        rows={2}
        placeholder="Add a comment…  (⏎ to add, ⇧⏎ newline)"
        className="mb-2.5 min-h-10 w-full resize-none border-none bg-transparent text-[12.5px] leading-relaxed text-text outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-2">
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-[11px] py-[7px] text-[11px] font-semibold text-dim"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onAdd(note)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-[13px] py-[7px] text-[11px] font-bold text-white"
        >
          <Check size={12} strokeWidth={2.4} />
          Add comment
        </button>
      </div>
    </div>
  );
}
