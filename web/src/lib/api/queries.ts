'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { webClient } from './client';
import {
  deriveThreadSummaries,
  selectThreadMessages,
  upsertByTs,
} from './messages';
import type {
  ApprovalDecision,
  ApproveRequest,
  SayRequest,
  ThreadStatus,
  WebOutboundMessage,
} from './types';

export const qk = {
  channels: () => ['channels'] as const,
  channelMessages: (channel: string) => ['channel-messages', channel] as const,
};

// ── Channels (repo picker) ───────────────────────────────────────────────────────────────────────
export function useChannels() {
  return useQuery({
    queryKey: qk.channels(),
    queryFn: async () => (await webClient.channels()).channels,
    staleTime: 30_000,
  });
}

// ── Whole-channel message cache (history hydrate; SSE keeps it live) ───────────────────────────────
export function useChannelMessages(channel: string | undefined) {
  return useQuery({
    queryKey: qk.channelMessages(channel ?? ''),
    queryFn: () => webClient.thread(channel as string),
    enabled: !!channel,
    // Live updates arrive over SSE; never auto-refetch (it would clobber optimistic user messages).
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

// ── Thread list (DEMO/live-outbox derivation — see BACKEND_GAPS.md #1) ─────────────────────────────
export function useThreadList(channel: string | undefined) {
  const { data, isLoading, isError } = useChannelMessages(channel);
  const threads = useMemo(
    () => (channel && data ? deriveThreadSummaries(channel, data) : []),
    [channel, data],
  );
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    if (data) for (const m of data) map.set(m.threadTs ?? m.ts, (map.get(m.threadTs ?? m.ts) ?? 0) + 1);
    return map;
  }, [data]);
  return { threads, counts, isLoading, isError };
}

// ── One thread's messages (root-coalesced) ─────────────────────────────────────────────────────────
export function useThreadMessages(channel: string | undefined, threadTs: string) {
  const { data, isLoading, isError } = useChannelMessages(channel);
  const messages = useMemo(
    () => (data ? selectThreadMessages(data, threadTs) : []),
    [data, threadTs],
  );
  return { messages, isLoading, isError };
}

// ── Pipeline outline (DERIVED — `/web/pipeline` is unreachable; BACKEND_GAPS.md #3) ─────────────────
export interface PipelineOutlineSection {
  ordinal: number;
  brief: string;
  active: boolean;
}

export interface PipelineOutline {
  status: ThreadStatus;
  decisions: ApprovalDecision[];
  sections: PipelineOutlineSection[];
  prUrl?: string;
  /** Build events are streaming for this thread. */
  live: boolean;
  /** An open approval card is awaiting a verdict. */
  gated: boolean;
}

const PR_URL_RE = /https?:\/\/github\.com\/\S+\/pull\/\d+/i;

export function usePipelineOutline(channel: string | undefined, threadTs: string): PipelineOutline {
  const { messages } = useThreadMessages(channel, threadTs);

  return useMemo(() => {
    const approval = [...messages].reverse().find((m) => m.card?.type === 'approval_card');
    const verdict = messages.some((m) => m.card?.type === 'verdict_card');
    const buildEvents = messages.filter(
      (m) => (m.meta as { kind?: string } | undefined)?.kind === 'build_event',
    );
    const prMsg = messages.find((m) => PR_URL_RE.test(m.text));
    const prUrl = prMsg ? (prMsg.text.match(PR_URL_RE)?.[0] ?? undefined) : undefined;

    const card = approval?.card?.type === 'approval_card' ? approval.card : undefined;
    const briefs = card?.sections ?? [];
    const activeIndex = buildEvents.length > 0 ? Math.min(briefs.length - 1, lastSection(buildEvents)) : -1;

    const sections: PipelineOutlineSection[] = briefs.map((brief, i) => ({
      ordinal: i + 1,
      brief,
      active: i === activeIndex,
    }));

    let status: ThreadStatus = 'scoping';
    if (prUrl) status = 'done';
    else if (card && !verdict) status = 'awaiting_approval';
    else if (buildEvents.length > 0 || verdict) status = 'running';

    return {
      status,
      decisions: card?.decisions ?? [],
      sections,
      prUrl,
      live: buildEvents.length > 0 && !prUrl,
      gated: !!card && !verdict,
    };
  }, [messages]);
}

function lastSection(buildEvents: WebOutboundMessage[]): number {
  let max = 0;
  for (const e of buildEvents) {
    const ord = (e.meta as { sectionOrdinal?: number } | undefined)?.sectionOrdinal;
    if (typeof ord === 'number') max = Math.max(max, ord);
  }
  // sectionOrdinal may be gap-numbered (10,20,…) or 1-based; clamp to a zero-based index best-effort.
  return max >= 10 ? Math.floor(max / 10) - 1 : Math.max(0, max - 1);
}

// ── Mutations ──────────────────────────────────────────────────────────────────────────────────────
const OPERATOR = { authorId: 'U-OPERATOR', authorName: 'Operator' };

interface SayVars {
  channel: string;
  text: string;
  threadTs?: string;
}

function appendLocal(qc: QueryClient, channel: string, msg: WebOutboundMessage) {
  qc.setQueryData<WebOutboundMessage[]>(qk.channelMessages(channel), (prev) =>
    upsertByTs(prev ?? [], msg),
  );
}

/** Post a human message. The operator's own bubble is appended optimistically (it never echoes back
 *  via history or SSE — BACKEND_GAPS.md #2); on success the temp ts is reconciled to the real one. */
export function useSay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: SayVars) => {
      const body: SayRequest = { ...vars, ...OPERATOR };
      return webClient.say(body);
    },
    onMutate: (vars) => {
      const tempTs = `local.${Date.now()}.${Math.floor(performance.now())}`;
      const optimistic: WebOutboundMessage = {
        ts: tempTs,
        channel: vars.channel,
        text: vars.text,
        threadTs: vars.threadTs,
        author: 'user',
        local: true,
        postedAt: new Date().toISOString(),
      };
      appendLocal(qc, vars.channel, optimistic);
      return { tempTs };
    },
    onSuccess: (data, vars, ctx) => {
      // Reconcile the optimistic ts → the real ts the surface minted.
      qc.setQueryData<WebOutboundMessage[]>(qk.channelMessages(vars.channel), (prev) =>
        (prev ?? []).map((m) => (m.ts === ctx?.tempTs ? { ...m, ts: data.ts } : m)),
      );
    },
    onError: (_e, vars, ctx) => {
      if (!ctx) return;
      qc.setQueryData<WebOutboundMessage[]>(qk.channelMessages(vars.channel), (prev) =>
        (prev ?? []).filter((m) => m.ts !== ctx.tempTs),
      );
    },
  });
}

/** Submit a plan verdict. No optimistic state needed — the card re-emits as a verdict over SSE with
 *  the same ts. `note` is collected but NOT plumbed by the backend (BACKEND_GAPS.md #5). */
export function useApprove() {
  return useMutation({
    mutationFn: (body: ApproveRequest) => webClient.approve(body),
  });
}
