"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { env } from "@/lib/env";
import { composerStore } from "./composer-store";
import { qk } from "./query-keys";
import { subscribeSse, type SseHandle } from "./sse-manager";

/**
 * The flat drafts-realtime row (`GET /web/drafts/realtime`) — mirrors the backend `DraftRow`. It NEVER
 * carries the payload: a staged secret's plaintext must not ride the WAL, so a delta only signals THAT a
 * draft changed; the client refetches `GET .../draft` to pull the new content.
 */
interface DraftRow {
  id: string;
  jobId: string;
  userId: string;
  orgId: string;
  updatedAt: string;
}

type DraftRowDelta =
  | { kind: "data"; rows: Array<{ pk: string; row: DraftRow }> }
  | { kind: "add"; pk: string; row: DraftRow }
  | { kind: "update"; pk: string; row: DraftRow }
  | { kind: "remove"; pk: string }
  // Sent by the backend when realtime is unavailable — close and rely on the store's own resync paths.
  | { kind: "disabled" };

/**
 * ONE cross-device subscription to the operator's own composer drafts — mounted once (in `AppChrome`).
 * A draft the operator edits on another device (or the server-side send-path clear) arrives here as a
 * flat delta; for every job the operator currently has open we refetch its draft (invalidating the
 * `qk.draft` query and feeding the `composerStore` under last-write-wins). Jobs the operator has NOT
 * opened have no local draft to reconcile, so their deltas are ignored until they open the job.
 */
export function useDraftsRealtime(): void {
  const qc = useQueryClient();

  useEffect(() => {
    const onFrame = (data: string, handle: SseHandle) => {
      let delta: DraftRowDelta | null = null;
      try {
        delta = JSON.parse(data) as DraftRowDelta;
      } catch {
        return;
      }
      if (!delta) return;
      if (delta.kind === "disabled") {
        handle.closePermanently();
        return;
      }
      // A clear is an UPDATE-to-empty, never a real `remove` — nothing to reconcile on a remove.
      if (delta.kind === "remove") return;
      const rows = delta.kind === "data" ? delta.rows.map((r) => r.row) : [delta.row];
      for (const row of rows) {
        void qc.invalidateQueries({ queryKey: qk.draft(row.jobId) });
        composerStore.pullServerDraft(row.jobId, Date.parse(row.updatedAt));
      }
    };

    return subscribeSse(`${env.NEXT_PUBLIC_HTTP_URL}/web/drafts/realtime`, {
      onFrame,
    });
  }, [qc]);
}
