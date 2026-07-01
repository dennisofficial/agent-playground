'use client';

import { useEffect, useMemo } from 'react';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { env } from '@/lib/env';
import { qk } from './query-keys';
import { subscribeSse } from './sse-manager';
import { useOrgs } from './me';
import { fetchOrgRepos, type RepoView } from './job-api';
import {
  addTicketDependency,
  createTicket,
  deleteTicket,
  fetchTicket,
  fetchTickets,
  promoteTicket,
  removeTicketDependency,
  updateTicket,
  type CreateTicketBody,
  type TicketRef,
  type UpdateTicketBody,
} from './tickets-api';

/** A repo in the flat tickets picker — its org context + the connected-repo view. */
export interface RepoChoice {
  orgId: string;
  orgName: string;
  repo: RepoView;
}

/**
 * Every connected repo across all the operator's orgs (the tickets repo sidebar). Built from the session
 * orgs + one `GET /orgs/:id/repos` per org (parallel). Only `accessOk` repos are conversation containers,
 * but we show all connected repos and let the board reflect emptiness.
 */
export function useAllRepos(): { repos: RepoChoice[]; isLoading: boolean } {
  const { orgs, isLoading: orgsLoading } = useOrgs();
  const results = useQueries({
    queries: orgs.map((o) => ({
      queryKey: qk.orgRepos(o.id),
      queryFn: () => fetchOrgRepos(o.id),
      staleTime: 30_000,
    })),
  });

  const repos = useMemo(() => {
    const out: RepoChoice[] = [];
    orgs.forEach((o, i) => {
      const list = results[i]?.data ?? [];
      for (const repo of list) out.push({ orgId: o.id, orgName: o.name, repo });
    });
    return out;
  }, [orgs, results]);

  const isLoading = orgsLoading || results.some((r) => r.isLoading);
  return { repos, isLoading };
}

export function useTickets(orgId: string, repoId: string) {
  const ref: TicketRef = { orgId, repoId };
  return useQuery({
    queryKey: qk.ticketsList(orgId, repoId),
    queryFn: () => fetchTickets(ref),
    enabled: !!orgId && !!repoId,
    staleTime: 10_000,
  });
}

export function useTicket(orgId: string, repoId: string, ticketId: string | null) {
  const ref: TicketRef = { orgId, repoId };
  return useQuery({
    queryKey: qk.ticketDetail(orgId, repoId, ticketId ?? ''),
    queryFn: () => fetchTicket(ref, ticketId as string),
    enabled: !!orgId && !!repoId && !!ticketId,
    staleTime: 5_000,
  });
}

function useTicketInvalidate(orgId: string, repoId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.ticketsList(orgId, repoId) });
    void qc.invalidateQueries({ queryKey: ['ticket-detail', orgId, repoId] });
  };
}

export function useCreateTicket(orgId: string, repoId: string) {
  const invalidate = useTicketInvalidate(orgId, repoId);
  return useMutation({
    mutationFn: (body: CreateTicketBody) => createTicket({ orgId, repoId }, body),
    onSuccess: invalidate,
  });
}

export function useUpdateTicket(orgId: string, repoId: string) {
  const invalidate = useTicketInvalidate(orgId, repoId);
  return useMutation({
    mutationFn: ({ ticketId, body }: { ticketId: string; body: UpdateTicketBody }) =>
      updateTicket({ orgId, repoId }, ticketId, body),
    onSuccess: invalidate,
  });
}

export function useDeleteTicket(orgId: string, repoId: string) {
  const invalidate = useTicketInvalidate(orgId, repoId);
  return useMutation({
    mutationFn: (ticketId: string) => deleteTicket({ orgId, repoId }, ticketId),
    onSuccess: invalidate,
  });
}

export function usePromoteTicket(orgId: string, repoId: string) {
  const invalidate = useTicketInvalidate(orgId, repoId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) => promoteTicket({ orgId, repoId }, ticketId),
    onSuccess: () => {
      invalidate();
      // A new thread may have been spun up — refresh the cross-org inbox so the sidebar shows it.
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

export function useAddTicketDependency(orgId: string, repoId: string) {
  const invalidate = useTicketInvalidate(orgId, repoId);
  return useMutation({
    mutationFn: ({ ticketId, dependsOnTicketId }: { ticketId: string; dependsOnTicketId: string }) =>
      addTicketDependency({ orgId, repoId }, ticketId, dependsOnTicketId),
    onSuccess: invalidate,
  });
}

export function useRemoveTicketDependency(orgId: string, repoId: string) {
  const invalidate = useTicketInvalidate(orgId, repoId);
  return useMutation({
    mutationFn: ({ ticketId, depId }: { ticketId: string; depId: string }) =>
      removeTicketDependency({ orgId, repoId }, ticketId, depId),
    onSuccess: invalidate,
  });
}

/**
 * Live board updates: the per-repo SSE (`…/repos/:repoId/events`) carries a `ticket_event` frame on every
 * board mutation — including when Atlas mutates a ticket mid-conversation, outside this client's flow. We
 * debounce-invalidate the list + detail so the board stays live. (Same connect/refresh-on-401 shape as the
 * thread stream; here we only care about the ticket frame.)
 */
export function useRepoTicketEvents(orgId: string, repoId: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!orgId || !repoId) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const refetch = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: qk.ticketsList(orgId, repoId) });
        void qc.invalidateQueries({ queryKey: ['ticket-detail', orgId, repoId] });
      }, 200);
    };

    const onFrame = (data: string) => {
      let frame: { type?: string } | null = null;
      try {
        frame = JSON.parse(data) as { type?: string };
      } catch {
        return;
      }
      if (frame?.type === 'ticket_event') refetch();
    };

    // Shares the ONE repo-events connection with `useJobEvents` (same URL) via the SSE manager.
    const url = `${env.NEXT_PUBLIC_HTTP_URL}/web/orgs/${orgId}/repos/${repoId}/events`;
    const unsubscribe = subscribeSse(url, { onFrame });
    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
  }, [orgId, repoId, qc]);
}
