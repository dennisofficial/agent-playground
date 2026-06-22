'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { webClient } from './client';
import { qk } from './query-keys';
import { upsertByTs } from './message-cache';
import type { ApproveRequest, SayRequest, WebOutboundMessage } from './types';

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
 *  the same ts. `note` (request_changes/deny reason) is plumbed end-to-end → the brain reads it. */
export function useApprove() {
  return useMutation({
    mutationFn: (body: ApproveRequest) => webClient.approve(body),
  });
}
