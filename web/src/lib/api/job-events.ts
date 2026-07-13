"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { env } from "@/lib/env";
import { qk } from "./query-keys";
import { subscribeSse } from "./sse-manager";
import type { InboxThread } from "./inbox";
import type { JobRef } from "./job-api";
import type { WireOrgUsage } from "./types";
import { writeUsageCache } from "./usage-cache";
import {
  applyStreamFrame,
  endLiveTurn,
  sweepLiveTurnsAfterReconnect,
} from "./job-stream";

/** A frame off the repo SSE: a durable-post change-signal, a live engine-stream frame, or a meta update. */
interface SseFrame {
  type?: string;
  jobId?: string;
  /** Which turn lane this stream frame belongs to: `'main'` (the brain) or `'phase:<stepId>'` (a build). */
  lane?: string;
  seq?: number;
  event?: {
    kind?: string;
    name?: string;
    input?: { file_path?: string; path?: string; notebook_path?: string };
  };
  /** `thread_meta` frame: the new thread title (e.g. an auto-generated one). */
  title?: string;
  /** `usage` frame: the org whose subscription usage snapshot changed. */
  orgId?: string;
  /** `usage` frame: the fresh subscription-usage snapshot to push into the ring's query cache. */
  usage?: WireOrgUsage;
}

/**
 * In-turn `/context` freshness: the brain authors `specs/` (and `artifacts/`) files DURING a turn via its
 * standard Write/Edit tools, but durable messages only persist at `turn_end` — so the SPECS/GENERATED/
 * ARTIFACTS listing would otherwise sit stale until the turn finishes. The `tool_use` engine events
 * already stream live, carrying the `file_path` being written, so we refetch the context listing the
 * moment a context file is touched. (Bash-based writes — echo/sed — don't surface as a Write tool_use and
 * are not covered here; they settle on the next `message`/`turn_end` reconcile.)
 */
const FILE_WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);
const CONTEXT_WRITE_RE = /\/context\/(specs|generated|artifacts|evidence)\//;

/**
 * Live updates for the open thread. The repo-scoped SSE (`…/repos/:repoId/events`) carries two frame
 * types (discriminated by `type`):
 *
 *  - `{ type: 'message', … }` — a durable post landed (chat / approval card / PR / status). Used as a
 *    CHANGE-SIGNAL: debounced-refetch the open thread's messages + pipeline (the authoritative,
 *    jobId-scoped reads). A sibling thread's activity also triggers a refetch — fine for an operator
 *    console.
 *  - `{ type: 'stream', jobId, event }` — a LIVE engine-stream frame (a `turn_start` marker, token deltas,
 *    thinking, tool calls/results, and a `turn_end` marker) for the in-sandbox session. Fed into the
 *    live-turn store (`job-stream.ts`) for EVERY thread in the repo; `turn_start` flips the working
 *    indicator on + records `startedAt` (the elapsed timer), and on `turn_end` we refetch `/messages` (now
 *    holding the persisted blocks) and THEN clear the live buffer (no flicker). A Stop = a graceful
 *    `turn_end` (no separate abort frame).
 *
 * Resilience (transient self-heal + the refresh/reconnect retry loop) lives in the shared `sse-manager`.
 *
 * The stream is REPO-scoped, so this hook subscribes per `(orgId, repoId)` — NOT per thread — and reads
 * the currently-open thread from a ref. That keeps ONE standing connection across thread switches within a
 * repo (a thread switch no longer tears the SSE down + reopens it), which is what used to churn the
 * HTTP/1.1 connection pool and stall every fetch in dev.
 */
export function useJobEvents(ref: JobRef): void {
  const qc = useQueryClient();
  const { orgId, repoId, jobId } = ref;

  // The open thread, read live by the frame handlers — so the standing subscription always targets the
  // CURRENT thread without re-subscribing when it changes.
  const openThreadRef = useRef(jobId);
  openThreadRef.current = jobId;

  useEffect(() => {
    if (!orgId || !repoId) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let ctxDebounce: ReturnType<typeof setTimeout> | null = null;

    // Built from the open thread at call time (not captured once) so the standing connection's debounced
    // invalidations always target whichever thread is open now.
    const liveRef = (): JobRef => ({
      orgId,
      repoId,
      jobId: openThreadRef.current,
    });
    // The 4-element prefix matches every open `/context` file for a thread (the 5th element is the path).
    const contextFilesKey = (r: JobRef) =>
      qk.threadContextFile(r, "").slice(0, 4);

    const refetch = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const r = liveRef();
        void qc.invalidateQueries({ queryKey: qk.threadMessages(r) });
        void qc.invalidateQueries({ queryKey: qk.threadPipeline(r) });
        void qc.invalidateQueries({ queryKey: qk.threadContext(r) });
        void qc.invalidateQueries({ queryKey: contextFilesKey(r) });
        void qc.invalidateQueries({ queryKey: qk.jobDiff(r) });
      }, 250);
    };

    // Context-only refetch (the listing + any open file's contents) — kept separate from `refetch()` so a
    // mid-turn spec write doesn't needlessly churn the messages/pipeline caches.
    const refetchContext = () => {
      if (ctxDebounce) clearTimeout(ctxDebounce);
      ctxDebounce = setTimeout(() => {
        const r = liveRef();
        void qc.invalidateQueries({ queryKey: qk.threadContext(r) });
        void qc.invalidateQueries({ queryKey: contextFilesKey(r) });
      }, 250);
    };

    const reconcileNow = (r: JobRef) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.threadMessages(r) }),
        qc.invalidateQueries({ queryKey: qk.threadPipeline(r) }),
        qc.invalidateQueries({ queryKey: qk.threadContext(r) }),
        qc.invalidateQueries({ queryKey: contextFilesKey(r) }),
        qc.invalidateQueries({ queryKey: qk.jobDiff(r) }),
      ]);

    const onFrame = (data: string) => {
      let frame: SseFrame | null = null;
      try {
        frame = JSON.parse(data) as SseFrame;
      } catch {
        refetch(); // unparseable → fall back to a change-signal refetch
        return;
      }
      if (frame?.type === "stream") {
        // The repo stream carries the live turn for EVERY thread in the repo. We feed them ALL into the
        // (thread-keyed) live-turn store — NOT just the open thread — so switching to a sibling thread that
        // is mid-stream is instant, with its already-streamed output present. (Before, this connection
        // re-opened per thread to re-trigger the snapshot; now it stands, so we must not drop siblings.)
        const fThread = frame.jobId;
        if (!fThread) return;
        // Which lane (the brain `main` turn, or a `phase:<stepId>` build turn). Lanes are independent
        // in-flight turns on the same thread; the conversation reads `main`, the step sub-page reads its phase.
        const lane = frame.lane ?? "main";
        if (frame.event?.kind === "turn_end") {
          // Reconcile: refetch durable messages, THEN clear THIS lane's live buffer (so no gap/flicker).
          // A Stop produces a graceful `turn_end` (there's no separate abort frame), so the same path clears
          // the indicator after a stop. For a non-open thread the invalidations just mark its (unobserved)
          // queries stale — no fetch.
          void reconcileNow({ orgId, repoId, jobId: fThread }).then(() => {
            endLiveTurn(fThread, lane);
          });
        } else {
          // Snapshot (catch-up on connect) or a live delta — both deduped by seq in the store, per lane.
          applyStreamFrame(fThread, lane, frame.seq ?? 0, frame.event);
          // A turn just STARTED: its kickoff-written durable rows (the `agent_prompt` prompt bubble that
          // opens each lane, a build phase's `build_anchor`) land via a plain DB insert — no `message`
          // frame — so without this they'd only surface on the `turn_end` reconcile, mid-turn invisible.
          // Refetch the open thread's messages now so the prompt shows while the agent is still working.
          if (
            frame.event?.kind === "turn_start" &&
            fThread === openThreadRef.current
          ) {
            refetch();
          }
          // In-turn freshness for the OPEN thread only: the brain just wrote a `/context` file via Write/Edit
          // → refresh the SPECS/GENERATED/ARTIFACTS listing now, instead of waiting for the durable reconcile.
          const ev = frame.event;
          const writePath =
            ev?.input?.file_path ?? ev?.input?.path ?? ev?.input?.notebook_path;
          if (
            fThread === openThreadRef.current &&
            ev?.kind === "tool_use" &&
            ev.name != null &&
            FILE_WRITE_TOOLS.has(ev.name) &&
            writePath != null
          ) {
            // ANY repo-file write changes the accumulated diff — invalidate it (cheap: the query is
            // disabled while the Changes pane is closed, so nothing refetches until it's opened).
            void qc.invalidateQueries({
              queryKey: qk.jobDiff({ orgId, repoId, jobId: fThread }),
            });
            if (CONTEXT_WRITE_RE.test(writePath)) refetchContext();
          }
        }
        return;
      }
      if (frame?.type === "thread_meta" && frame.jobId && frame.title) {
        // A thread title changed (e.g. the auto-generated one). Patch the inbox cache in place — the
        // sidebar AND the navigator header both read the title from `allJobs` — then invalidate as a
        // backstop. (The navigator/sidebar update live; no message frame is involved in titling.)
        const { jobId: id, title } = frame;
        qc.setQueryData<InboxThread[]>(qk.allJobs(), (prev) =>
          prev?.map((t) => (t.id === id ? { ...t, title } : t)),
        );
        void qc.invalidateQueries({ queryKey: qk.allJobs() });
        return;
      }
      if (frame?.type === "usage" && frame.usage) {
        // Subscription-usage push (distinct from the per-turn `stream`/`usage` context-window frame): the
        // backend recomputed this org's usage snapshot (a harvested-window burn during a turn, or an account
        // switch). The stream is already server-filtered to this connection's org, so patch the ring's cache
        // in place — no refetch, no poll. Mirror it to localStorage too; a pushed snapshot is as real as a
        // REST-fetched one, and the next reload should seed from it even if no ring component is mounted now.
        writeUsageCache(qk.orgUsage(orgId).join(":"), frame.usage, Date.now());
        qc.setQueryData(qk.orgUsage(orgId), frame.usage);
        return;
      }
      // `{ type: 'message' }` (or any non-stream frame) — a durable post landed → change-signal refetch.
      refetch();
    };

    // (Re)connect catch-up. On a genuine reconnect (a backend watch-restart, a network blip) anything may
    // have landed while the stream was down AND queries that errored during the outage are stuck on
    // last-good data — reconcile the open thread's caches (invalidate refetches errored-active queries
    // too) and sweep live-turn lanes the replayed snapshots don't re-confirm (a turn that ended while we
    // were down would otherwise show "working…" until a manual reload). On a late-join to an already-open
    // stream nothing was missed (mounting queries fetch for themselves), so just refresh `allJobs` to
    // catch a title generated before this subscriber attached.
    const onOpen = (_handle: unknown, kind: "connect" | "late-join") => {
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
      if (kind !== "connect") return;
      void reconcileNow(liveRef());
      sweepLiveTurnsAfterReconnect();
    };

    const url = `${env.NEXT_PUBLIC_HTTP_URL}/web/orgs/${orgId}/repos/${repoId}/events`;
    const unsubscribe = subscribeSse(url, { onFrame, onOpen });
    return () => {
      if (debounce) clearTimeout(debounce);
      if (ctxDebounce) clearTimeout(ctxDebounce);
      unsubscribe();
    };
  }, [orgId, repoId, qc]);
}
