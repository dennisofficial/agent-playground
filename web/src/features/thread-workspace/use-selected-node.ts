'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * The workspace has TWO independent panes, each with its own selection (design "Atlas Workspace HiFi"):
 *
 *  - the LEFT pane (`?lane=`) is a THREADS lane — the Main brain conversation (no param) or a build
 *    track/step transcript. Highlighted ORANGE in the navigator.
 *  - the RIGHT pane (`?node=`) is a DETAIL node — an OUTPUT (spec/artifact/generated), a sandbox port, a
 *    subagent run, the diff/plan/decision docs, a review lens. Highlighted BLUE in the navigator.
 *
 * Both live in the URL as separate params so they're independent (Main can stay open on the left while a
 * spec is open on the right — the two highlights coexist), deep-linkable, refresh-stable, and Back-aware.
 * A `?lane=`/`?node=` change is a query-only navigation on the same `[threadKey]` route, so
 * `ThreadWorkspace` stays mounted and its live SSE connection (`useThreadEvents`) is NOT torn down — only a
 * real thread switch (different `[threadKey]`) remounts and reconnects.
 */
const LANE_PARAM = 'lane';
const NODE_PARAM = 'node';

/** DETAIL nodes render in the RIGHT pane; every other (bare track/step id) is a LANE for the LEFT pane. */
const DETAIL_LITERALS = new Set(['plan', 'decision', 'diff']);
const DETAIL_PREFIX = /^(spec|gen|artifact|port|subagent|rev|secplan):/;

/** Whether a navigator node opens in the RIGHT (detail) pane rather than the LEFT (lane/conversation) one. */
export function isDetailNode(node: string): boolean {
  return DETAIL_LITERALS.has(node) || DETAIL_PREFIX.test(node);
}

export interface SelectedNode {
  /** The LEFT pane's open lane (`?lane=`) — a track/step id, or `null` for the Main conversation. */
  laneNode: string | null;
  /** The RIGHT pane's open detail node (`?node=`), or `null` for the empty detail pane. */
  detailNode: string | null;
  /** Open a node in whichever pane it belongs to ({@link isDetailNode}); the OTHER pane's selection is
   *  preserved. Pass `{ push: true }` to force a history entry (e.g. following a link inside a doc). */
  selectNode: (node: string, opts?: { push?: boolean }) => void;
  /** Return the LEFT pane to the Main conversation (drop `?lane=`); the right detail stays open. */
  openConversation: () => void;
  /** Close the RIGHT detail pane (drop `?node=`); the left lane stays open. */
  closeDetail: () => void;
}

export function useSelectedNode(): SelectedNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const laneNode = params.get(LANE_PARAM);
  const detailNode = params.get(NODE_PARAM);

  const selectNode = useCallback(
    (node: string, opts?: { push?: boolean }) => {
      const detail = isDetailNode(node);
      const key = detail ? NODE_PARAM : LANE_PARAM;
      const wasEmpty = !params.get(key); // this pane had no selection → opening it is a discrete step
      // Preserve the OTHER pane's param; only rewrite this pane's.
      const qs = new URLSearchParams(params.toString());
      qs.set(key, node);
      const href = `${pathname}?${qs.toString()}`;
      // Opening a pane is a discrete step (Back closes it); switching between siblings in the same pane
      // replaces so browsing doesn't stack history. `opts.push` overrides — following a LINK inside a doc
      // is a navigation the user expects Back to reverse.
      if (opts?.push || wasEmpty) router.push(href);
      else router.replace(href);
    },
    [params, pathname, router],
  );

  const dropParam = useCallback(
    (key: string, present: boolean) => {
      if (!present) return;
      const qs = new URLSearchParams(params.toString());
      qs.delete(key);
      const query = qs.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [params, pathname, router],
  );

  const openConversation = useCallback(() => dropParam(LANE_PARAM, Boolean(laneNode)), [dropParam, laneNode]);
  const closeDetail = useCallback(() => dropParam(NODE_PARAM, Boolean(detailNode)), [dropParam, detailNode]);

  return { laneNode, detailNode, selectNode, openConversation, closeDetail };
}
