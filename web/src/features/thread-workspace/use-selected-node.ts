'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * The workspace has TWO panes, each with its own selection, plus a stacked sub-agent layer on the right
 * (design "Atlas Workspace HiFi"):
 *
 *  - the LEFT pane (`?lane=`) is a THREADS lane — the Main brain conversation (no param) or a build
 *    track/step transcript. Highlighted ORANGE in the navigator.
 *  - the RIGHT pane (`?node=`) is a DETAIL node — an OUTPUT (spec/artifact/generated), a sandbox port, the
 *    diff/plan/decision docs, a review lens. Highlighted BLUE in the navigator.
 *  - a SUB-AGENT (`?sub=`) STACKS on top of the right pane: opening one keeps `?node=` (its nav row stays
 *    selected) and renders the sub-agent transcript with a breadcrumb back to that base node. It's a
 *    second-level page, not a replacement — closing it returns to the base.
 *
 * All three live in the URL as separate params so they're independent (Main + a spec + a sub-agent can all
 * be open at once), deep-linkable, refresh-stable, and Back-aware. A param change is a query-only navigation
 * on the same `[threadKey]` route, so `ThreadWorkspace` stays mounted and its live SSE connection
 * (`useThreadEvents`) is NOT torn down — only a real thread switch (different `[threadKey]`) reconnects.
 */
const LANE_PARAM = 'lane';
const NODE_PARAM = 'node';
const SUB_PARAM = 'sub';

/** DETAIL nodes render in the RIGHT pane; every other (bare track/step id) is a LANE for the LEFT pane.
 *  (`subagent:` is neither — it stacks via `?sub=`, handled in `selectNode`.) */
const DETAIL_LITERALS = new Set(['plan', 'decision', 'diff']);
const DETAIL_PREFIX = /^(spec|gen|artifact|port|rev|secplan):/;

/** Whether a navigator node opens in the RIGHT (detail) pane rather than the LEFT (lane/conversation) one. */
export function isDetailNode(node: string): boolean {
  return DETAIL_LITERALS.has(node) || DETAIL_PREFIX.test(node);
}

export interface SelectedNode {
  /** The LEFT pane's open lane (`?lane=`) — a track/step id, or `null` for the Main conversation. */
  laneNode: string | null;
  /** The RIGHT pane's open detail node (`?node=`), or `null` for the empty detail pane. */
  detailNode: string | null;
  /** The sub-agent (parent tool-use id) stacked on top of the right pane (`?sub=`), or `null`. */
  subNode: string | null;
  /** Open a node in whichever pane/layer it belongs to: `subagent:<id>` → the stacked `?sub=` layer (base
   *  detail preserved); {@link isDetailNode} → the right pane (`?node=`, clearing any stacked sub); else the
   *  left lane (`?lane=`). The other panes' selections are preserved. `{ push: true }` forces a history
   *  entry (e.g. following a link inside a doc). */
  selectNode: (node: string, opts?: { push?: boolean }) => void;
  /** Return the LEFT pane to the Main conversation (drop `?lane=`); the right detail + sub stay open. */
  openConversation: () => void;
  /** Close the RIGHT detail pane (drop `?node=` AND any stacked `?sub=`); the left lane stays open. */
  closeDetail: () => void;
  /** Pop the stacked sub-agent (drop `?sub=`), returning to the base detail node. */
  closeSub: () => void;
}

export function useSelectedNode(): SelectedNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const laneNode = params.get(LANE_PARAM);
  const detailNode = params.get(NODE_PARAM);
  const subNode = params.get(SUB_PARAM);

  const selectNode = useCallback(
    (node: string, opts?: { push?: boolean }) => {
      const qs = new URLSearchParams(params.toString());
      let key: string;
      if (node.startsWith('subagent:')) {
        // Stack the sub-agent on top of the right pane — the base `?node=` (and its nav highlight) stays.
        key = SUB_PARAM;
        qs.set(SUB_PARAM, node.slice('subagent:'.length));
      } else if (isDetailNode(node)) {
        key = NODE_PARAM;
        qs.set(NODE_PARAM, node);
        qs.delete(SUB_PARAM); // a new base detail resets the stacked sub-agent
      } else {
        key = LANE_PARAM;
        qs.set(LANE_PARAM, node);
      }
      const wasEmpty = !params.get(key); // this pane/layer had no selection → opening it is a discrete step
      const href = `${pathname}?${qs.toString()}`;
      // Opening a pane/layer is a discrete step (Back closes it); switching siblings in the same one
      // replaces so browsing doesn't stack history. `opts.push` overrides (following a doc LINK).
      if (opts?.push || wasEmpty) router.push(href);
      else router.replace(href);
    },
    [params, pathname, router],
  );

  const dropParams = useCallback(
    (keys: string[]) => {
      if (!keys.some((k) => params.get(k))) return;
      const qs = new URLSearchParams(params.toString());
      for (const k of keys) qs.delete(k);
      const query = qs.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [params, pathname, router],
  );

  const openConversation = useCallback(() => dropParams([LANE_PARAM]), [dropParams]);
  const closeDetail = useCallback(() => dropParams([NODE_PARAM, SUB_PARAM]), [dropParams]);
  const closeSub = useCallback(() => dropParams([SUB_PARAM]), [dropParams]);

  return { laneNode, detailNode, subNode, selectNode, openConversation, closeDetail, closeSub };
}
