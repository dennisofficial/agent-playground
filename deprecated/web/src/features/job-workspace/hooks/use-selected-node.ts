'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { isDetailNode, parseFileNode } from '../lib/node-registry';

const LANE_PARAM = 'lane';
const NODE_PARAM = 'node';
const SUB_PARAM = 'sub';
const FILE_PARAM = 'file';

export interface SelectedNode {
  /** The LEFT pane's open lane (`?lane=`) — a thread/step id, or `null` for the Main conversation. */
  laneNode: string | null;
  /** The RIGHT pane's open detail node (`?node=`), or `null` for the empty detail pane. */
  detailNode: string | null;
  /** The sub-agent (parent tool-use id) stacked on top of the right pane (`?sub=`), or `null`. */
  subNode: string | null;
  /** The lane the open sub-agent's Task anchor lives on (encoded into `?sub=` as `<lane>::<parentId>` by
   *  {@link subagentNode}), or `null` if no sub-agent is open. Needed to subscribe to the right live turn —
   *  a subagent spawned inside a build thread streams on THAT thread's lane, never Main's. */
  subLane: string | null;
  /** Open a node in whichever pane/layer it belongs to: `subagent:<lane>::<id>` → the stacked `?sub=` layer
   *  (base detail preserved); {@link isDetailNode} → the right pane (`?node=`, clearing any stacked sub);
   *  else the left lane (`?lane=`). The other panes' selections are preserved. `{ push: true }` forces a
   *  history entry (e.g. following a link inside a doc). */
  selectNode: (node: string, opts?: { push?: boolean }) => void;
  /** Return the LEFT pane to the Main conversation (drop `?lane=`); the right detail + sub stay open. */
  openConversation: () => void;
  /** Close the RIGHT detail pane (drop `?node=` AND any stacked `?sub=`); the left lane stays open. */
  closeDetail: () => void;
  /** Pop the stacked sub-agent (drop `?sub=`), returning to the base detail node. */
  closeSub: () => void;
  /** The stacked repo-file view's path (`?file=`), or `null` when no file view is open. */
  fileNode: string | null;
  /** The optional line target of the open file view (`"18"` / `"18-24"`), or `null`. */
  fileLines: string | null;
  /** Pop the stacked repo-file view (drop `?file=`), returning to the base spec/plan. */
  closeFile: () => void;
}

export function useSelectedNode(): SelectedNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const laneNode = params.get(LANE_PARAM);
  const detailNode = params.get(NODE_PARAM);
  const subParam = params.get(SUB_PARAM);
  // `subagentNode` encodes `<lane>::<parentId>`; tolerate a bare id (no `::`) for old links/bookmarks.
  const subSep = subParam?.indexOf('::') ?? -1;
  const subLane = subParam && subSep >= 0 ? subParam.slice(0, subSep) : null;
  const subNode = subParam == null ? null : subSep >= 0 ? subParam.slice(subSep + 2) : subParam;
  const fileParam = params.get(FILE_PARAM);
  // The param stores the path WITHOUT the `file:` prefix (as `?sub=` stores without `subagent:`).
  const fileSel = fileParam ? parseFileNode(`file:${fileParam}`) : null;

  const selectNode = useCallback(
    (node: string, opts?: { push?: boolean }) => {
      const qs = new URLSearchParams(params.toString());
      let key: string;
      if (node.startsWith('file:')) {
        // Stack the file view on top of the right pane — the base `?node=` (spec/plan) stays selected.
        key = FILE_PARAM;
        qs.set(FILE_PARAM, node.slice('file:'.length));
      } else if (node.startsWith('subagent:')) {
        // Stack the sub-agent on top of the right pane — the base `?node=` (and its nav highlight) stays.
        key = SUB_PARAM;
        qs.set(SUB_PARAM, node.slice('subagent:'.length));
      } else if (isDetailNode(node)) {
        key = NODE_PARAM;
        qs.set(NODE_PARAM, node);
        qs.delete(SUB_PARAM); // a new base detail resets the stacked sub-agent
        qs.delete(FILE_PARAM); // ...and the stacked file view
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
  const closeDetail = useCallback(
    () => dropParams([NODE_PARAM, SUB_PARAM, FILE_PARAM]),
    [dropParams],
  );
  const closeSub = useCallback(() => dropParams([SUB_PARAM]), [dropParams]);
  const closeFile = useCallback(() => dropParams([FILE_PARAM]), [dropParams]);

  return {
    laneNode,
    detailNode,
    subNode,
    subLane,
    selectNode,
    openConversation,
    closeDetail,
    closeSub,
    fileNode: fileSel?.path ?? null,
    fileLines: fileSel?.lines ?? null,
    closeFile,
  };
}
