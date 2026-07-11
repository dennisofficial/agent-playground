"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { JobRef } from "@/lib/api/job-api";
import { composerStore, useComposerDraft } from "@/lib/api/composer-store";

/**
 * The inline review-comment feature ("Atlas Workspace HiFi" — select text in the detail pane → comment →
 * queue as a chip above the composer → send the batch to Atlas as one message).
 *
 * Cross-pane state — a comment is AUTHORED in the RIGHT detail pane (a file/doc) but QUEUED/SENT in the
 * LEFT composer — so it lives in a workspace-level context, the same pattern as `MarkdownActionsProvider`
 * in `markdown.tsx`: created once in `job-workspace.tsx`, wrapping both panes.
 */

/** Which open node a comment is attached to (`node` ties it to the right pane's `?node=`; `label` is the
 *  short display name — e.g. the file's basename — shown on its chip). */
export interface CommentTarget {
  node: string;
  label: string;
}

export interface ReviewComment {
  id: string;
  file: CommentTarget;
  quote: string;
  note: string;
}

/** A selection awaiting a note — the popover renders from this. `rect` is VIEWPORT coords (the popover is
 *  `position:fixed`); `range` is the live cloned Range, kept only long enough to register the pending
 *  highlight and, on Add, hand off to the committed one. */
export interface PendingSelection {
  quote: string;
  rect: DOMRect;
  range: Range;
  file: CommentTarget;
}

export interface ReviewCommentsApi {
  comments: ReviewComment[];
  pending: PendingSelection | null;
  /** Which detail node is open right now (null when the right pane shows something non-commentable). Set by
   *  `PhaseView` so a fresh selection tags the comment with the right file. */
  activeTarget: CommentTarget | null;
  setActiveTarget: (t: CommentTarget | null) => void;
  beginPending: (sel: { quote: string; rect: DOMRect; range: Range }) => void;
  cancelPending: () => void;
  addComment: (note: string) => void;
  removeComment: (id: string) => void;
  clearComments: () => void;
}

const ReviewCommentsContext = createContext<ReviewCommentsApi | null>(null);

/** Feature-detect the CSS Custom Highlight API once — degrades gracefully (chips + send still work, just
 *  no visual underline) on browsers that lack it (older Firefox/Safari). */
const HL_SUPPORTED =
  typeof CSS !== "undefined" && typeof CSS.highlights !== "undefined";

const COMMITTED_NAME = "atlas-comment";
const PENDING_NAME = "atlas-comment-pending";

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ReviewCommentsProvider({
  jobRef,
  children,
}: {
  jobRef: JobRef;
  children: ReactNode;
}) {
  // Queued review-comments are per-Job (store-backed) so they don't bleed between Jobs and their
  // serializable metadata survives reload. The DOM `Range`/highlight machinery below stays per-mount.
  const comments = useComposerDraft(jobRef).comments;
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [activeTarget, setActiveTargetState] = useState<CommentTarget | null>(
    null,
  );

  // Every mutator below is wrapped in `useCallback(fn, [])` so its identity is STABLE across renders —
  // consumers (like `PhaseView`'s `setActiveTarget` effect) can safely depend on it without re-firing every
  // time comment/pending state changes. That means the mutators must read current values from REFS, never
  // from the React state variables above (a state closure would go stale the moment the callback is memoized
  // with an empty dep array) — so `pending`/`activeTarget` are mirrored into refs alongside their state.
  const committedHl = useRef<Highlight | null>(null);
  const pendingHl = useRef<Highlight | null>(null);
  const rangesRef = useRef<Map<string, { range: Range; file: CommentTarget }>>(
    new Map(),
  );
  const activeTargetRef = useRef<CommentTarget | null>(null);
  const pendingRef = useRef<PendingSelection | null>(null);

  // Register the two named highlights once. Registration is idempotent (`CSS.highlights.set` on the same
  // name just replaces the entry), so React 19 StrictMode's mount→unmount→mount is safe as long as cleanup
  // does NOT delete the named entry — only clear its ranges — otherwise the second mount's `Highlight`
  // object would exist but never be (re-)registered.
  useEffect(() => {
    if (!HL_SUPPORTED) return;
    committedHl.current = new Highlight();
    pendingHl.current = new Highlight();
    CSS.highlights.set(COMMITTED_NAME, committedHl.current);
    CSS.highlights.set(PENDING_NAME, pendingHl.current);
    return () => {
      committedHl.current?.clear();
      pendingHl.current?.clear();
    };
  }, []);

  /** Rebuild the COMMITTED highlight from ranges belonging to the currently-open file only. Switching files
   *  unmounts the previous file's DOM, so its Ranges go stale (collapsed / disconnected) — we don't try to
   *  persist or re-derive them; the chip stays in the tray, but the visual underline only ever shows for
   *  the file that's actually on screen. */
  const rebuildCommittedHighlight = useCallback(() => {
    if (!HL_SUPPORTED || !committedHl.current) return;
    committedHl.current.clear();
    const activeNode = activeTargetRef.current?.node;
    if (!activeNode) return;
    for (const { range, file } of rangesRef.current.values()) {
      if (file.node !== activeNode) continue;
      if (range.collapsed) continue;
      if (!range.startContainer.isConnected) continue;
      committedHl.current.add(range);
    }
  }, []);

  // On Job switch the chip list swaps (store-backed per Job), but the range Map holds the OLD Job's DOM
  // Ranges (now belonging to unmounted content). Drop them and rebuild so no stale underline lingers.
  useEffect(() => {
    rangesRef.current.clear();
    rebuildCommittedHighlight();
  }, [jobRef.jobId, rebuildCommittedHighlight]);

  const setActiveTarget = useCallback(
    (t: CommentTarget | null) => {
      // No-op guard: `PhaseView` calls this on every render of a stable node — without this, each call
      // would still push a fresh `activeTarget` state object and re-render every consumer for nothing.
      const prev = activeTargetRef.current;
      if (prev?.node === t?.node && prev?.label === t?.label) return;
      activeTargetRef.current = t;
      setActiveTargetState(t);
      rebuildCommittedHighlight();
    },
    [rebuildCommittedHighlight],
  );

  const beginPending = useCallback(
    (sel: { quote: string; rect: DOMRect; range: Range }) => {
      const file = activeTargetRef.current;
      if (!file) return;
      if (HL_SUPPORTED && pendingHl.current) {
        pendingHl.current.clear();
        pendingHl.current.add(sel.range);
      }
      const next: PendingSelection = { ...sel, file };
      pendingRef.current = next;
      setPending(next);
    },
    [],
  );

  const cancelPending = useCallback(() => {
    pendingHl.current?.clear();
    pendingRef.current = null;
    setPending(null);
  }, []);

  const addComment = useCallback(
    (note: string) => {
      const current = pendingRef.current;
      if (!current) return;
      const id = newId();
      rangesRef.current.set(id, { range: current.range, file: current.file });
      pendingHl.current?.clear();
      rebuildCommittedHighlight();
      composerStore.setComments(jobRef, (cs) => [
        ...cs,
        { id, file: current.file, quote: current.quote, note: note.trim() },
      ]);
      pendingRef.current = null;
      setPending(null);
    },
    [rebuildCommittedHighlight, jobRef],
  );

  const removeComment = useCallback(
    (id: string) => {
      rangesRef.current.delete(id);
      composerStore.setComments(jobRef, (cs) => cs.filter((c) => c.id !== id));
      rebuildCommittedHighlight();
    },
    [rebuildCommittedHighlight, jobRef],
  );

  const clearComments = useCallback(() => {
    rangesRef.current.clear();
    committedHl.current?.clear();
    composerStore.setComments(jobRef, () => []);
  }, [jobRef]);

  const api = useMemo<ReviewCommentsApi>(
    () => ({
      comments,
      pending,
      activeTarget,
      setActiveTarget,
      beginPending,
      cancelPending,
      addComment,
      removeComment,
      clearComments,
    }),
    [
      comments,
      pending,
      activeTarget,
      setActiveTarget,
      beginPending,
      cancelPending,
      addComment,
      removeComment,
      clearComments,
    ],
  );

  return (
    <ReviewCommentsContext.Provider value={api}>
      {children}
    </ReviewCommentsContext.Provider>
  );
}

export function useReviewComments(): ReviewCommentsApi {
  const ctx = useContext(ReviewCommentsContext);
  if (!ctx)
    throw new Error(
      "useReviewComments must be used within a ReviewCommentsProvider",
    );
  return ctx;
}

/**
 * Format the queued comments (grouped by file) into the markdown sent to Atlas — mirrors the backend's
 * `formatReviewComments` so the operator's chip preview matches what's actually delivered. Kept here (not
 * shared with the backend) since the two run in different runtimes; the shapes are the shared contract.
 */
export function formatReviewComments(
  comments: ReviewComment[],
  message?: string,
): string {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const list = byFile.get(c.file.label);
    if (list) list.push(c);
    else byFile.set(c.file.label, [c]);
  }
  const lines: string[] = [
    `${comments.length} review comment${comments.length === 1 ? "" : "s"}:`,
    "",
  ];
  for (const [file, items] of byFile) {
    lines.push(`**${file}**`);
    for (const c of items) {
      lines.push(`> "${c.quote}"`);
      if (c.note) lines.push(`— ${c.note}`);
      lines.push("");
    }
  }
  if (message?.trim()) lines.push(message.trim());
  return lines.join("\n").trim();
}
