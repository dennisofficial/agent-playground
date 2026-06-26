'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * The selected navigator node lives in the `?node=` search param — a single source of truth for "which
 * node is open in the right split pane". Keeping it in the URL makes a node view deep-linkable, shareable,
 * and refresh-stable, gives the back button meaning inside a thread, and (because there is exactly one
 * selection state) kills the stale-highlight bug where closing the pane left a file row highlighted.
 *
 * A `?node=` change is a query-only navigation on the same `[threadKey]` route, so `ThreadWorkspace` stays
 * mounted and its live SSE connection (`useThreadEvents`) is NOT torn down — only a real thread switch
 * (different `[threadKey]`) remounts and reconnects.
 */
const NODE_PARAM = 'node';

export interface SelectedNode {
  /** The current node token (e.g. `spec:plan.md`, `diff`, a phase id), or `null` for conversation-only. */
  selectedNode: string | null;
  /** Open a node in the right pane. `URLSearchParams` handles encoding of `:` / `/` in the token. */
  selectNode: (node: string) => void;
  /** Close the pane back to conversation-only by dropping `?node=`. */
  openConversation: () => void;
}

export function useSelectedNode(): SelectedNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selectedNode = params.get(NODE_PARAM);

  const selectNode = useCallback(
    (node: string) => {
      const qs = new URLSearchParams();
      qs.set(NODE_PARAM, node);
      const href = `${pathname}?${qs.toString()}`;
      // Entering phase mode is a discrete step (Back closes the pane); switching between nodes replaces so
      // sibling browsing doesn't stack history.
      if (selectedNode) router.replace(href);
      else router.push(href);
    },
    [pathname, router, selectedNode],
  );

  const openConversation = useCallback(() => {
    if (selectedNode) router.push(pathname);
  }, [pathname, router, selectedNode]);

  return { selectedNode, selectNode, openConversation };
}
