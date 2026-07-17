"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { isDetailNode, parseFileNode } from "./node-registry";

/**
 * The workspace has TWO panes, plus a stacked sub-agent layer on the right (design "Atlas Workspace HiFi"):
 *
 *  - the LEFT pane is the ROUTED thread (`/workspace/:jobKey/:threadId`) — the planner ("Main") conversation,
 *    a build/leg transcript, the Codex plan-review dialogue, or a review-agent / review-fix child thread.
 *    Selecting one is a ROUTE navigation (the last path segment changes), not a query param.
 *  - the RIGHT pane (`?node=`) is a DETAIL node — an OUTPUT (spec/artifact/generated), a sandbox port, a
 *    service log, the diff/plan/decision docs. Highlighted BLUE in the navigator.
 *  - a SUB-AGENT (`?sub=`) STACKS on top of the right pane: opening one keeps `?node=` (its nav row stays
 *    selected) and renders the sub-agent transcript with a breadcrumb back to that base node. It's a
 *    second-level page, not a replacement — closing it returns to the base.
 *
 * The detail layers live in the URL as separate query params so they're independent (a thread + a spec + a
 * sub-agent can all be open at once), deep-linkable, refresh-stable, and Back-aware. A query change is a
 * query-only navigation on the same route, so `JobWorkspace` stays mounted and its live SSE connection
 * (`useJobEvents`) is NOT torn down. A thread switch changes only the `:threadId` segment (same `[jobKey]`),
 * preserving those query layers.
 */
const NODE_PARAM = "node";
const SUB_PARAM = "sub";
const FILE_PARAM = "file";

// `isDetailNode` (which pane a node opens in) now lives in the node registry — the single source of truth.
export { isDetailNode } from "./node-registry";

export interface SelectedNode {
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
   *  else a THREAD select → route navigation to `/workspace/:jobKey/:threadId`. The detail layers are
   *  preserved. `{ push: true }` forces a history entry (e.g. following a link inside a doc). */
  selectNode: (node: string, opts?: { push?: boolean }) => void;
  /** Close the RIGHT detail pane (drop `?node=` AND any stacked `?sub=`); the routed thread stays. */
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
  const detailNode = params.get(NODE_PARAM);
  const subParam = params.get(SUB_PARAM);
  // `subagentNode` encodes `<lane>::<parentId>`; tolerate a bare id (no `::`) for old links/bookmarks.
  const subSep = subParam?.indexOf("::") ?? -1;
  const subLane = subParam && subSep >= 0 ? subParam.slice(0, subSep) : null;
  const subNode =
    subParam == null
      ? null
      : subSep >= 0
        ? subParam.slice(subSep + 2)
        : subParam;
  const fileParam = params.get(FILE_PARAM);
  // The param stores the path WITHOUT the `file:` prefix (as `?sub=` stores without `subagent:`).
  const fileSel = fileParam ? parseFileNode(`file:${fileParam}`) : null;

  const selectNode = useCallback(
    (node: string, opts?: { push?: boolean }) => {
      const qs = new URLSearchParams(params.toString());
      // A THREAD select changes the last path segment (`:threadId`), preserving the detail-pane query
      // layers — a route navigation, not a query set.
      if (
        !node.startsWith("file:") &&
        !node.startsWith("subagent:") &&
        !isDetailNode(node)
      ) {
        const segs = pathname.split("/");
        // pathname is `/workspace/:jobKey/:threadId`; swap the thread segment (append it if a bare
        // `/workspace/:jobKey` shell hasn't got one yet).
        if (segs.length >= 4) segs[3] = encodeURIComponent(node);
        else segs.push(encodeURIComponent(node));
        const query = qs.toString();
        const href = `${segs.join("/")}${query ? `?${query}` : ""}`;
        router.push(href);
        return;
      }
      let key: string;
      if (node.startsWith("file:")) {
        // Stack the file view on top of the right pane — the base `?node=` (spec/plan) stays selected.
        key = FILE_PARAM;
        qs.set(FILE_PARAM, node.slice("file:".length));
      } else if (node.startsWith("subagent:")) {
        // Stack the sub-agent on top of the right pane — the base `?node=` (and its nav highlight) stays.
        key = SUB_PARAM;
        qs.set(SUB_PARAM, node.slice("subagent:".length));
      } else {
        key = NODE_PARAM;
        qs.set(NODE_PARAM, node);
        qs.delete(SUB_PARAM); // a new base detail resets the stacked sub-agent
        qs.delete(FILE_PARAM); // ...and the stacked file view
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

  const closeDetail = useCallback(
    () => dropParams([NODE_PARAM, SUB_PARAM, FILE_PARAM]),
    [dropParams],
  );
  const closeSub = useCallback(() => dropParams([SUB_PARAM]), [dropParams]);
  const closeFile = useCallback(() => dropParams([FILE_PARAM]), [dropParams]);

  return {
    detailNode,
    subNode,
    subLane,
    selectNode,
    closeDetail,
    closeSub,
    fileNode: fileSel?.path ?? null,
    fileLines: fileSel?.lines ?? null,
    closeFile,
  };
}
