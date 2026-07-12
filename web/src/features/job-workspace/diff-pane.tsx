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
import { useJobDiff, useJobMessages } from "@/lib/api/job-queries";
import type { JobRef } from "@/lib/api/job-api";
import type { JobDiffFile } from "@/lib/api/types";
import { rowsFromHunk, type DiffRow } from "./tool-calls/diff-rows";
import { anchorEnd, anchorLabel, deriveLineAnchor } from "./diff-anchor";
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
          jobRef={jobRef}
          file={file}
          collapsed={collapsed.has(file.path)}
          onToggleCollapse={() => toggleCollapse(file.path)}
        />
      ))}
    </div>
  );
}

/** A comment rendered inline on the diff, in one of its two persisted states (the third — `composing` —
 *  is the live `InlineComposer`). `queued` lives in the composer store until sent; `sent` is read back
 *  from the job's `review_comments_card` messages so it stays anchored after the batch goes out. */
type InlineThread = {
  key: string;
  state: "queued" | "sent";
  label: string;
  note: string;
  /** Only queued comments can be removed (they haven't left the composer yet). */
  onRemove?: () => void;
};

function DiffFileSection({
  jobRef,
  file,
  collapsed,
  onToggleCollapse,
}: {
  jobRef: JobRef;
  file: JobDiffFile;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const { addLineComment, comments, removeComment } = useReviewComments();
  const { data: messages } = useJobMessages(jobRef);
  const sectionRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  // `draggingRef` drives the synchronous mousemove extension (read in a stable callback); this reactive
  // twin gates the inline composer so it appears only AFTER the drag is released, not while selecting.
  const [dragging, setDragging] = useState(false);
  const [selection, setSelection] = useState<{
    anchorIdx: number;
    headIdx: number;
  } | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  // Which stored comment thread is hovered — its exact lines get the full wash so OVERLAPPING comments
  // stay distinguishable (at rest each commented line shows only a quiet gutter marker, not a full wash).
  const [hoveredThreadKey, setHoveredThreadKey] = useState<string | null>(null);

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

  // Map a stored line anchor (side + end line) back to the flat row it docks under, so a queued/sent
  // comment re-attaches to the diff exactly where it was made. Falls back across sides, then to the last
  // row, so a comment never disappears even if its exact line isn't in view.
  const rowIdxByLine = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of flatRows) {
      if (r.oldNo != null) m.set(`old:${r.oldNo}`, r.flatIdx);
      if (r.newNo != null) m.set(`new:${r.newNo}`, r.flatIdx);
    }
    return m;
  }, [flatRows]);
  const lastIdx = flatRows.length ? flatRows[flatRows.length - 1].flatIdx : -1;
  const anchorIdxFor = useCallback(
    (a: { oldEnd?: number; newEnd?: number }) => {
      const end = anchorEnd(a);
      if (!end) return lastIdx;
      return (
        rowIdxByLine.get(`${end.side}:${end.line}`) ??
        rowIdxByLine.get(`new:${end.line}`) ??
        rowIdxByLine.get(`old:${end.line}`) ??
        lastIdx
      );
    },
    [rowIdxByLine, lastIdx],
  );

  // Queued (still in the composer, removable) + sent (read back from review_comments_card messages, so they
  // persist on the diff after the batch is sent) threads for THIS file. One pass builds: `threadsByIdx`
  // (grouped by docking row, for rendering); `anchoredIdx` (every commented row — gets a quiet gutter marker
  // at rest); and `rowsByKey` (each thread's exact rows — the full wash lights up only for the hovered one,
  // so overlapping comments stay legible).
  const { threadsByIdx, anchoredIdx, rowsByKey } = useMemo(() => {
    const byIdx = new Map<number, InlineThread[]>();
    const anchored = new Set<number>();
    const rowsByKey = new Map<string, number[]>();
    const rowsForAnchor = (a: {
      oldStart?: number;
      oldEnd?: number;
      newStart?: number;
      newEnd?: number;
    }): number[] => {
      const out: number[] = [];
      for (const r of flatRows) {
        const inOld =
          a.oldStart != null &&
          r.oldNo != null &&
          r.oldNo >= a.oldStart &&
          r.oldNo <= a.oldEnd!;
        const inNew =
          a.newStart != null &&
          r.newNo != null &&
          r.newNo >= a.newStart &&
          r.newNo <= a.newEnd!;
        if (inOld || inNew) out.push(r.flatIdx);
      }
      return out;
    };
    const add = (
      thread: InlineThread,
      lines: {
        oldStart?: number;
        oldEnd?: number;
        newStart?: number;
        newEnd?: number;
      },
    ) => {
      const rows = rowsForAnchor(lines);
      rowsByKey.set(thread.key, rows);
      for (const idx of rows) anchored.add(idx);
      const dockIdx = anchorIdxFor(lines);
      const list = byIdx.get(dockIdx);
      if (list) list.push(thread);
      else byIdx.set(dockIdx, [thread]);
    };
    for (const m of messages ?? []) {
      if (m.card?.type !== "review_comments_card") continue;
      m.card.items.forEach((it, i) => {
        if (it.lines?.path !== file.path) return;
        add(
          {
            key: `sent:${m.ts}:${i}`,
            state: "sent",
            label: anchorLabel(it.lines),
            note: it.note ?? "",
          },
          it.lines,
        );
      });
    }
    for (const c of comments) {
      if (c.lines?.path !== file.path) continue;
      add(
        {
          key: `queued:${c.id}`,
          state: "queued",
          label: anchorLabel(c.lines),
          note: c.note,
          onRemove: () => removeComment(c.id),
        },
        c.lines,
      );
    }
    return { threadsByIdx: byIdx, anchoredIdx: anchored, rowsByKey };
  }, [messages, comments, file.path, flatRows, anchorIdxFor, removeComment]);

  // The hovered thread's exact rows — these get the full accent wash; every other commented row shows only
  // the quiet gutter marker. Empty when nothing is hovered.
  const hoveredRows = useMemo(
    () => new Set(hoveredThreadKey ? (rowsByKey.get(hoveredThreadKey) ?? []) : []),
    [hoveredThreadKey, rowsByKey],
  );

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

  const beginSelect = useCallback(
    (idx: number, shift: boolean) => {
      setSelection((prev) => {
        if (!shift || !prev) return { anchorIdx: idx, headIdx: idx };
        if (flatRows[idx]?.hunkIdx !== flatRows[prev.anchorIdx]?.hunkIdx)
          return prev;
        return { anchorIdx: prev.anchorIdx, headIdx: idx };
      });
      if (shift) return;
      // A plain press starts a drag: extend `head` as the pointer moves over rows, until mouseup. The
      // composer stays hidden while `dragging` is true and only surfaces once the pointer is released.
      draggingRef.current = true;
      setDragging(true);
      const onUp = () => {
        draggingRef.current = false;
        setDragging(false);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mouseup", onUp);
    },
    [flatRows],
  );

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
      addLineComment({ path: file.path, ...anchor, note });
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
          style={{ background: "var(--term)", lineHeight: 1.75, overflowX: "auto" }}
        >
          {/* max-content + min-width:100% makes every row as wide as the WIDEST line, so the add/del tints
              and the selection/anchor highlight span the full content width even when scrolled right. */}
          <div style={{ width: "max-content", minWidth: "100%", padding: "8px 0" }}>
          {file.binary ? (
            <div className="px-5 py-1 text-term-dim" style={{ color: "var(--term-dim)" }}>
              Binary file
            </div>
          ) : file.hunks.length === 0 ? (
            <div className="px-5 py-1" style={{ color: "var(--term-dim)" }}>
              Diff hidden — file too large
            </div>
          ) : (
            hunks.map(({ hunk, hi, rows }) => (
              <div key={hi}>
                <div
                  className="flex items-center px-3 py-1 text-[10px]"
                  style={{ color: "var(--term-purple)" }}
                >
                  @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},
                  {hunk.newLines} @@
                </div>
                {rows.map((r) => {
                  const inActiveSel =
                    range != null &&
                    r.flatIdx >= range.lo &&
                    r.flatIdx <= range.hi;
                  // Full wash only for the ACTIVE drag selection or the HOVERED comment's lines; every
                  // other commented row just gets a quiet gutter marker (so overlaps don't merge).
                  const selected = inActiveSel || hoveredRows.has(r.flatIdx);
                  const marked = !selected && anchoredIdx.has(r.flatIdx);
                  return (
                    <Fragment key={r.key}>
                      <DiffRowLine
                        row={r}
                        tokens={lineTokens?.[r.flatIdx]}
                        selected={selected}
                        marked={marked}
                        hovered={hoveredIdx === r.flatIdx && !selected}
                        onMouseDownRow={(shift) => beginSelect(r.flatIdx, shift)}
                        onMouseEnterRow={() => onRowEnter(r.flatIdx)}
                        onMouseLeaveRow={() =>
                          setHoveredIdx((h) => (h === r.flatIdx ? null : h))
                        }
                        onAdd={() => beginSelect(r.flatIdx, false)}
                      />
                      {threadsByIdx.get(r.flatIdx)?.map((t) => (
                        <InlineCommentThread
                          key={t.key}
                          state={t.state}
                          label={t.label}
                          note={t.note}
                          onRemove={t.onRemove}
                          onHoverChange={(h) =>
                            setHoveredThreadKey(h ? t.key : null)
                          }
                        />
                      ))}
                      {!dragging && range != null && r.flatIdx === range.hi && anchor ? (
                        <InlineComposer
                          label={anchorLabel(anchor)}
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
        </div>
      )}
    </div>
  );
}

function DiffRowLine({
  row,
  tokens,
  selected,
  marked,
  hovered,
  onMouseDownRow,
  onMouseEnterRow,
  onMouseLeaveRow,
  onAdd,
}: {
  row: FileRow;
  tokens: ThemedToken[] | null | undefined;
  selected: boolean;
  /** Carries a comment but isn't the focused/selected one — shows a quiet gutter marker, not a full wash. */
  marked: boolean;
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
        // Active selection OR the hovered comment's lines — the BRIGHT accent wash.
        background: "color-mix(in srgb, var(--accent) 26%, var(--term))",
        boxShadow: "inset 3px 0 0 var(--accent)",
      }
    : marked
      ? {
          // A commented line at rest: the SAME full accent wash, just dimmer — so it's clearly visible,
          // and hovering its comment brightens it (which is how overlapping comments stay distinguishable).
          background: "color-mix(in srgb, var(--accent) 12%, var(--term))",
          boxShadow: "inset 3px 0 0 color-mix(in srgb, var(--accent) 60%, transparent)",
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

/** A persisted inline comment docked under its line range — `queued` (pending send, removable) or `sent`
 *  (already delivered, read back from the message log). The live typing state is `InlineComposer` above.
 *  "Quiet / note-forward" style: no pill — a small amber dot / green check + faint word carries state, the
 *  note is the hero, and the remove × reveals on hover (queued only). Sent is quieter: borderless + dimmed. */
function InlineCommentThread({
  state,
  label,
  note,
  onRemove,
  onHoverChange,
}: {
  state: "queued" | "sent";
  label: string;
  note: string;
  onRemove?: () => void;
  /** Hovering the thread lights up its exact lines on the diff (so overlapping comments stay legible). */
  onHoverChange?: (hovered: boolean) => void;
}) {
  const sent = state === "sent";
  return (
    <div
      className="group my-2 rounded-[9px]"
      style={{
        // Pinned to the scroller's left edge + width-capped so the thread stays readable and doesn't
        // stretch to the widest code line inside the horizontal max-content scroller.
        position: "sticky",
        left: 0,
        margin: "8px 14px",
        maxWidth: 640,
        background: sent
          ? "var(--surface-2)"
          : "color-mix(in srgb, var(--amber) 5%, var(--surface-2))",
        border: `1px solid ${sent ? "transparent" : "var(--border)"}`,
        padding: "9px 11px 10px",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <div className="mb-[5px] flex items-center gap-1.5">
        {sent ? (
          <Check
            size={11}
            strokeWidth={2.6}
            className="flex-none"
            style={{ color: "var(--green)" }}
          />
        ) : (
          <span
            className="h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: "var(--amber)" }}
          />
        )}
        <span
          className="font-mono text-[9.5px] font-semibold tracking-[0.04em]"
          style={{ color: sent ? "var(--faint)" : "var(--accent-2)" }}
        >
          {sent ? "Sent" : "Pending"}
        </span>
        <span className="font-mono text-[9px]" style={{ color: "var(--border-2)" }}>
          ·
        </span>
        <span className="font-mono text-[9.5px]" style={{ color: "var(--faint)" }}>
          {label}
        </span>
        <span className="flex-1" />
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove comment"
            className="flex h-[17px] w-[17px] items-center justify-center rounded-[5px] text-faint opacity-0 transition group-hover:opacity-100 hover:text-[var(--red)] focus-visible:opacity-100"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>
      <div
        className="text-[12.5px] leading-[1.5]"
        style={{ color: sent ? "var(--dim)" : "var(--text)" }}
      >
        {note || <span className="text-faint">No note added</span>}
      </div>
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
      className="rounded-[13px] border border-border-2 bg-panel p-3"
      style={{
        position: "sticky",
        left: 0,
        margin: "6px 14px",
        maxWidth: 640,
        boxShadow: "var(--shadow-menu)",
      }}
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
        placeholder="Add a comment…"
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
