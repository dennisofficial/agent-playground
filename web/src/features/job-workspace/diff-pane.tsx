"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range as VirtualRange,
} from "@tanstack/react-virtual";
import { Check, MessageSquarePlus, Plus, X } from "lucide-react";
import { useJobDiff, useJobMessages } from "@/lib/api/job-queries";
import type { JobRef } from "@/lib/api/job-api";
import type { JobDiffFile } from "@/lib/api/types";
import { rowsFromHunk, type DiffRow } from "./tool-calls/diff-rows";
import { anchorEnd, anchorLabel, deriveLineAnchor } from "./diff-anchor";
import {
  langFromPath,
  renderTokenLine,
  tokenizeLineSync,
  useEnsureHighlightLangs,
  type ThemedToken,
} from "./tool-calls/highlight";
import { useReviewComments } from "./review-comments";

/**
 * The Changes pane — a full-bleed, GitHub-style unified diff of the job's accumulated worktree change.
 * Every file is fully expanded under a sticky header over a dark `--term` code surface. Hovering a row
 * exposes a gutter `+`; clicking or drag-selecting a contiguous range opens an inline composer that queues
 * a line-anchored review comment (via `addLineComment`), which rides the normal review-comment pipeline to
 * the composer tray and out to Atlas.
 *
 * The whole multi-file diff is flattened into ONE list of items (file headers, hunk headers, rows, docked
 * comments, the active composer) and row-level virtualized with `@tanstack/react-virtual`, so a diff of
 * thousands of rows only ever mounts the ~viewport's worth of rows — and only tokenizes those on-screen
 * rows — instead of mounting and syntax-highlighting every file at once.
 */

const NBSP = " ";
const GUTTER = 28;
const SIGN = 16;
/** `fileIdx * HUNK_KEY_STRIDE + hunkIdx` — a per-file-namespaced hunk id that doubles as the same-hunk
 *  contiguity guard: because it encodes `fileIdx`, comparing it also prevents a selection crossing files. */
const HUNK_KEY_STRIDE = 100_000;
/** Min content width (in `ch`) so a diff with no rows still fills the pane. */
const MIN_CODE_LEN = 40;

/** First-pass estimates; `measureElement` corrects each once it renders, so these need only be close. */
const ESTIMATE: Record<DiffItem["kind"], number> = {
  row: 19,
  hunk: 22,
  file: 40,
  note: 24,
  comment: 84,
  composer: 160,
};

type FileRow = DiffRow & { gIdx: number; fileIdx: number; hunkKey: number };

/** One entry in the flattened, windowed diff list spanning every file. */
type DiffItem =
  | { kind: "file"; key: string; file: JobDiffFile; fileIdx: number }
  | { kind: "note"; key: string; text: string }
  | { kind: "hunk"; key: string; label: string }
  | { kind: "row"; key: string; row: FileRow; fileIdx: number; hunkKey: number }
  | { kind: "comment"; key: string; thread: InlineThread }
  | { kind: "composer"; key: string };

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

const NO_FILES: JobDiffFile[] = [];

const fileKey = (file: JobDiffFile): string =>
  file.oldPath ? `${file.oldPath}→${file.path}` : file.path;

export function DiffPane({ jobRef }: { jobRef: JobRef }) {
  const { data, isLoading, error } = useJobDiff(jobRef, true);
  const { addLineComment, comments, removeComment } = useReviewComments();
  const { data: messages } = useJobMessages(jobRef);
  const files = data?.files ?? NO_FILES;

  // Load every grammar present in the diff once (distinct-only), globally — not per-row, not per-file-mount.
  // Its internal state bump re-renders the pane so rows painted plain (before their lang loaded) recolorize.
  const fileLangByIdx = useMemo(() => files.map((f) => langFromPath(f.path)), [files]);
  useEnsureHighlightLangs(fileLangByIdx);

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

  // The whole diff's skeleton: structural items (file/note/hunk/row) for every file, plus O(1) lookups
  // keyed by the GLOBAL, monotonic row index `gIdx`. `rowsByGIdx` is built in the SAME order `gIdx` is
  // assigned, so a contiguous selection is a plain `slice(lo, hi + 1)` over it. Line→gIdx maps and the
  // file's last row are namespaced per file (line numbers reset per file) for comment anchoring.
  const built = useMemo(() => {
    const structural: DiffItem[] = [];
    const rowsByGIdx: FileRow[] = [];
    const rowsByFile: FileRow[][] = [];
    const lineMapByFile: Map<string, number>[] = [];
    const lastIdxByFile: number[] = [];
    let maxCodeLen = 0;
    let gIdx = 0;

    files.forEach((file, fileIdx) => {
      structural.push({ kind: "file", key: fileKey(file), file, fileIdx });
      const fileRows: FileRow[] = [];
      const lineMap = new Map<string, number>();
      if (file.binary) {
        structural.push({ kind: "note", key: `note:${fileIdx}`, text: "Binary file" });
      } else if (file.hunks.length === 0) {
        structural.push({
          kind: "note",
          key: `note:${fileIdx}`,
          text: "Diff hidden — file too large",
        });
      } else {
        file.hunks.forEach((hunk, hi) => {
          const hunkKey = fileIdx * HUNK_KEY_STRIDE + hi;
          structural.push({
            kind: "hunk",
            key: `hunk:${fileIdx}:${hi}`,
            label: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
          });
          for (const r of rowsFromHunk(hunk, hi * HUNK_KEY_STRIDE)) {
            const row: FileRow = { ...r, gIdx, fileIdx, hunkKey };
            if (row.oldNo != null) lineMap.set(`old:${row.oldNo}`, gIdx);
            if (row.newNo != null) lineMap.set(`new:${row.newNo}`, gIdx);
            if (row.code.length > maxCodeLen) maxCodeLen = row.code.length;
            rowsByGIdx[gIdx] = row;
            fileRows.push(row);
            structural.push({ kind: "row", key: `row:${gIdx}`, row, fileIdx, hunkKey });
            gIdx++;
          }
        });
      }
      rowsByFile[fileIdx] = fileRows;
      lineMapByFile[fileIdx] = lineMap;
      lastIdxByFile[fileIdx] = fileRows.length
        ? fileRows[fileRows.length - 1].gIdx
        : -1;
    });

    return {
      structural,
      rowsByGIdx,
      rowsByFile,
      lineMapByFile,
      lastIdxByFile,
      maxCodeLen,
    };
  }, [files]);

  // Stable monospace content width computed from data (nothing is mounted to measure): as wide as the
  // WIDEST code line so add/del tints + the selection/anchor wash span the full width even scrolled right;
  // `minWidth:100%` (applied on the spacer/rows) keeps it never narrower than the container.
  const contentWidth = `calc(${GUTTER * 2 + SIGN}px + ${Math.max(built.maxCodeLen, MIN_CODE_LEN)}ch)`;

  // Queued (still in the composer, removable) + sent (read back from review_comments_card messages, so they
  // persist on the diff after the batch is sent) threads across ALL files. One pass builds: `threadsByGIdx`
  // (grouped by docking gIdx, for rendering); `anchoredIdx` (every commented row — gets a quiet gutter
  // marker at rest); and `rowsByKey` (each thread's exact rows — the full wash lights up only for the
  // hovered one, so overlapping comments stay legible).
  const { threadsByGIdx, anchoredIdx, rowsByKey } = useMemo(() => {
    const byIdx = new Map<number, InlineThread[]>();
    const anchored = new Set<number>();
    const rowsByKey = new Map<string, number[]>();
    const fileIdxByPath = new Map<string, number>();
    files.forEach((f, i) => fileIdxByPath.set(f.path, i));

    // Map a stored line anchor (side + end line) back to the file-local row it docks under, so a queued/sent
    // comment re-attaches exactly where it was made. Falls back across sides, then to the file's last row,
    // so a comment never disappears even if its exact line isn't present.
    const anchorIdxFor = (
      fileIdx: number,
      a: { oldEnd?: number; newEnd?: number },
    ): number => {
      const lastIdx = built.lastIdxByFile[fileIdx] ?? -1;
      const end = anchorEnd(a);
      if (!end) return lastIdx;
      const lineMap = built.lineMapByFile[fileIdx];
      return (
        lineMap.get(`${end.side}:${end.line}`) ??
        lineMap.get(`new:${end.line}`) ??
        lineMap.get(`old:${end.line}`) ??
        lastIdx
      );
    };
    const rowsForAnchor = (
      fileIdx: number,
      a: { oldStart?: number; oldEnd?: number; newStart?: number; newEnd?: number },
    ): number[] => {
      const out: number[] = [];
      for (const r of built.rowsByFile[fileIdx] ?? []) {
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
        if (inOld || inNew) out.push(r.gIdx);
      }
      return out;
    };
    const add = (
      fileIdx: number,
      thread: InlineThread,
      lines: { oldStart?: number; oldEnd?: number; newStart?: number; newEnd?: number },
    ) => {
      const rows = rowsForAnchor(fileIdx, lines);
      rowsByKey.set(thread.key, rows);
      for (const idx of rows) anchored.add(idx);
      const dockIdx = anchorIdxFor(fileIdx, lines);
      const list = byIdx.get(dockIdx);
      if (list) list.push(thread);
      else byIdx.set(dockIdx, [thread]);
    };

    for (const m of messages ?? []) {
      if (m.card?.type !== "review_comments_card") continue;
      m.card.items.forEach((it, i) => {
        if (!it.lines) return;
        const fileIdx = fileIdxByPath.get(it.lines.path);
        if (fileIdx == null) return;
        add(
          fileIdx,
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
      if (!c.lines) continue;
      const fileIdx = fileIdxByPath.get(c.lines.path);
      if (fileIdx == null) continue;
      add(
        fileIdx,
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
    return { threadsByGIdx: byIdx, anchoredIdx: anchored, rowsByKey };
  }, [built, files, messages, comments, removeComment]);

  // The hovered thread's exact rows — these get the full accent wash; every other commented row shows only
  // the quiet gutter marker. Empty when nothing is hovered.
  const hoveredRows = useMemo(
    () => new Set(hoveredThreadKey ? (rowsByKey.get(hoveredThreadKey) ?? []) : []),
    [hoveredThreadKey, rowsByKey],
  );

  // Structural items with each docked comment spliced in immediately after its row. Rebuilds only when the
  // skeleton or comment set changes — NOT while dragging (the composer, which does depend on selection, is
  // spliced separately below).
  const baseItems = useMemo(() => {
    if (threadsByGIdx.size === 0) return built.structural;
    const out: DiffItem[] = [];
    for (const item of built.structural) {
      out.push(item);
      if (item.kind === "row") {
        const threads = threadsByGIdx.get(item.row.gIdx);
        if (threads)
          for (const t of threads)
            out.push({ kind: "comment", key: `comment:${t.key}`, thread: t });
      }
    }
    return out;
  }, [built, threadsByGIdx]);

  const range = selection
    ? {
        lo: Math.min(selection.anchorIdx, selection.headIdx),
        hi: Math.max(selection.anchorIdx, selection.headIdx),
      }
    : null;
  const selectedRows = range ? built.rowsByGIdx.slice(range.lo, range.hi + 1) : [];
  const anchor = deriveLineAnchor(selectedRows);

  // The single composer docks right after the tail row of the active selection — only once the drag is
  // released (`!dragging`) and the selection yields a valid anchor. Keyed by the primitive `gIdx` so the
  // splice memo stays stable across renders that don't move the composer.
  const composerHi =
    !dragging && selection && anchor && range ? range.hi : null;
  const items = useMemo(() => {
    if (composerHi == null) return baseItems;
    const out: DiffItem[] = [];
    for (const item of baseItems) {
      out.push(item);
      if (item.kind === "row" && item.row.gIdx === composerHi)
        out.push({ kind: "composer", key: "composer" });
    }
    return out;
  }, [baseItems, composerHi]);

  const fileItemIndices = useMemo(() => {
    const out: number[] = [];
    items.forEach((it, i) => {
      if (it.kind === "file") out.push(i);
    });
    return out;
  }, [items]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The `file`-item index whose section holds the first visible item — the header pinned to the top. Set
  // inside `rangeExtractor` (which runs on every scroll) and read back at render to mark that one sticky.
  const stickyFileIdxRef = useRef(0);

  const rangeExtractor = useCallback(
    (vr: VirtualRange) => {
      const active =
        [...fileItemIndices].reverse().find((i) => i <= vr.startIndex) ??
        fileItemIndices[0] ??
        0;
      stickyFileIdxRef.current = active;
      const next = new Set([active, ...defaultRangeExtractor(vr)]);
      return [...next].sort((a, b) => a - b);
    },
    [fileItemIndices],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => ESTIMATE[items[i].kind],
    overscan: 12,
    getItemKey: (i) => items[i].key,
    rangeExtractor,
  });

  // Clicking outside the scroller (or Escape) drops the in-progress selection + its composer.
  useEffect(() => {
    if (!selection) return;
    const onPointerDown = (e: PointerEvent) => {
      if (scrollRef.current && !scrollRef.current.contains(e.target as Node))
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
    (gi: number, shift: boolean) => {
      setSelection((prev) => {
        if (!shift || !prev) return { anchorIdx: gi, headIdx: gi };
        if (
          built.rowsByGIdx[gi]?.hunkKey !== built.rowsByGIdx[prev.anchorIdx]?.hunkKey
        )
          return prev;
        return { anchorIdx: prev.anchorIdx, headIdx: gi };
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
    [built],
  );

  const onRowEnter = useCallback(
    (gi: number) => {
      setHoveredIdx(gi);
      if (draggingRef.current)
        setSelection((prev) => {
          if (!prev) return prev;
          // Keep the drag-selection contiguous within a single hunk: `hunkKey` encodes `fileIdx`, so this
          // also blocks a drag from crossing a hunk-header divider OR into another file.
          if (
            built.rowsByGIdx[gi]?.hunkKey !==
            built.rowsByGIdx[prev.anchorIdx]?.hunkKey
          )
            return prev;
          return { ...prev, headIdx: gi };
        });
    },
    [built],
  );

  const submitComment = useCallback(
    (note: string) => {
      if (!anchor || !range) return;
      const fileIdx = built.rowsByGIdx[range.lo]?.fileIdx;
      if (fileIdx == null) return;
      addLineComment({ path: files[fileIdx].path, ...anchor, note });
      setSelection(null);
    },
    [anchor, range, addLineComment, built, files],
  );

  const renderItem = useCallback(
    (item: DiffItem) => {
      switch (item.kind) {
        case "file":
          return <FileHeader file={item.file} first={item.fileIdx === 0} />;
        case "note":
          return (
            <div
              className="px-5 py-1"
              style={{ background: "var(--term)", color: "var(--term-dim)" }}
            >
              {item.text}
            </div>
          );
        case "hunk":
          return (
            <div
              className="flex items-center px-3 py-1 text-[10px]"
              style={{ background: "var(--term)", color: "var(--term-purple)" }}
            >
              {item.label}
            </div>
          );
        case "row": {
          const gi = item.row.gIdx;
          const inActiveSel = range != null && gi >= range.lo && gi <= range.hi;
          // Full wash only for the ACTIVE drag selection or the HOVERED comment's lines; every other
          // commented row just gets a quiet gutter marker (so overlaps don't merge).
          const selected = inActiveSel || hoveredRows.has(gi);
          const marked = !selected && anchoredIdx.has(gi);
          return (
            <DiffRowLine
              row={item.row}
              tokens={tokenizeLineSync(item.row.code, fileLangByIdx[item.fileIdx])}
              selected={selected}
              marked={marked}
              hovered={hoveredIdx === gi && !selected}
              onMouseDownRow={(shift) => beginSelect(gi, shift)}
              onMouseEnterRow={() => onRowEnter(gi)}
              onMouseLeaveRow={() =>
                setHoveredIdx((h) => (h === gi ? null : h))
              }
              onAdd={() => beginSelect(gi, false)}
            />
          );
        }
        case "comment":
          return (
            <InlineCommentThread
              state={item.thread.state}
              label={item.thread.label}
              note={item.thread.note}
              onRemove={item.thread.onRemove}
              onHoverChange={(h) =>
                setHoveredThreadKey(h ? item.thread.key : null)
              }
            />
          );
        case "composer":
          return anchor ? (
            <InlineComposer
              label={anchorLabel(anchor)}
              onAdd={submitComment}
              onCancel={() => setSelection(null)}
            />
          ) : null;
      }
    },
    [
      range,
      anchor,
      hoveredRows,
      anchoredIdx,
      hoveredIdx,
      fileLangByIdx,
      beginSelect,
      onRowEnter,
      submitComment,
    ],
  );

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

  const virtualItems = virtualizer.getVirtualItems();
  const stickyIndex = stickyFileIdxRef.current;

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto overflow-x-auto"
      style={{ background: "var(--term)" }}
    >
      {data.truncated ? (
        <div className="border-b border-border bg-surface-2 px-5 py-2 font-mono text-[11px] text-dim">
          Diff truncated — open the PR to see everything.
        </div>
      ) : null}
      <div
        className="relative font-mono text-[11px]"
        style={{
          height: virtualizer.getTotalSize(),
          width: contentWidth,
          minWidth: "100%",
          lineHeight: 1.75,
        }}
      >
        {virtualItems.map((vi) => {
          const sticky = vi.index === stickyIndex;
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="left-0 top-0"
              style={
                sticky
                  ? {
                      position: "sticky",
                      top: 0,
                      zIndex: 11,
                      width: contentWidth,
                      minWidth: "100%",
                    }
                  : {
                      position: "absolute",
                      transform: `translateY(${vi.start}px)`,
                      width: contentWidth,
                      minWidth: "100%",
                    }
              }
            >
              {renderItem(items[vi.index])}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The sticky per-file bar: path + add/del/status badges. Always shown (files are never collapsed). Pinned
 *  to the scroller's left edge so it stays in view during horizontal scroll, exactly like the inline
 *  comment/composer cards. */
function FileHeader({ file, first }: { file: JobDiffFile; first: boolean }) {
  const headerPath =
    file.status === "renamed" && file.oldPath
      ? `${file.oldPath} → ${file.path}`
      : file.path;
  return (
    <div
      className="flex w-full items-center gap-2 px-5 py-2.5"
      style={{
        position: "sticky",
        left: 0,
        background: "var(--surface-2)",
        borderBottom: "1px solid var(--border)",
        borderTop: first ? undefined : "1px solid var(--term-border)",
      }}
    >
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
      data-diff-row
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
        // stretch to the widest code line inside the horizontal scroller.
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
