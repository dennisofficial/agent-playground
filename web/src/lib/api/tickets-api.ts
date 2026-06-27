'use client';

import { env } from '@/lib/env';
import { fetchWithRefresh } from './refresh';

/**
 * The per-repo board/backlog web API (`/web/orgs/:orgId/repos/:repoId/tickets/...`). Credentialed via the
 * session cookie + `fetchWithRefresh` (re-ups an expired access cookie, retries once). Mirrors the
 * thread-api contract; the backend list is enriched with `blocked` / `blockedBy` / `linkedThreadId` so the
 * board renders without N detail fetches.
 */

const BASE = `${env.NEXT_PUBLIC_HTTP_URL}/web`;

export type TicketStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TicketKind = 'feature' | 'bug' | 'chore';

/** Immutable provenance snapshot stamped at capture time (survives source deletion). */
export interface TicketOrigin {
  threadTitle?: string;
  decisionSummary?: string;
}

/** A board/backlog list row (the enriched list DTO). */
export interface TicketListRow {
  id: string;
  number: number;
  title: string;
  body: string | null;
  status: TicketStatus;
  priority: TicketPriority | null;
  kind: TicketKind | null;
  sortOrder: number;
  originThreadId: string | null;
  originDecisionRecordId: string | null;
  origin: TicketOrigin | null;
  createdAt: string;
  updatedAt: string;
  blocked: boolean;
  blockedBy: number | null;
  linkedThreadId: string | null;
}

/** A compact reference to a related ticket (dependency lists). */
export interface TicketLite {
  id: string;
  number: number;
  title: string;
  status: TicketStatus;
}

/** The full ticket detail (drawer) — base fields + advisory deps + the 1:1 thread link. */
export interface TicketDetail {
  id: string;
  number: number;
  title: string;
  body: string | null;
  status: TicketStatus;
  priority: TicketPriority | null;
  kind: TicketKind | null;
  sortOrder: number;
  originThreadId: string | null;
  originDecisionRecordId: string | null;
  origin: TicketOrigin | null;
  createdAt: string;
  updatedAt: string;
  blocked: boolean;
  linkedThreadId: string | null;
  dependsOn: TicketLite[];
  blocks: TicketLite[];
}

export interface TicketRef {
  orgId: string;
  repoId: string;
}

export class TicketApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TicketApiError';
  }
}

async function ticketJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithRefresh(`${BASE}${path}`, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new TicketApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function ticketsPath(ref: TicketRef, suffix = ''): string {
  return `/orgs/${ref.orgId}/repos/${ref.repoId}/tickets${suffix}`;
}

export function fetchTickets(ref: TicketRef): Promise<TicketListRow[]> {
  return ticketJson<TicketListRow[]>(ticketsPath(ref));
}

export function fetchTicket(ref: TicketRef, ticketId: string): Promise<TicketDetail> {
  return ticketJson<TicketDetail>(ticketsPath(ref, `/${ticketId}`));
}

export interface CreateTicketBody {
  title: string;
  body?: string | null;
  priority?: TicketPriority | null;
  kind?: TicketKind | null;
  status?: TicketStatus;
  dependsOn?: string[];
}

export function createTicket(ref: TicketRef, body: CreateTicketBody): Promise<TicketListRow> {
  return ticketJson(ticketsPath(ref), { method: 'POST', body: JSON.stringify(body) });
}

export interface UpdateTicketBody {
  title?: string;
  body?: string | null;
  status?: TicketStatus;
  priority?: TicketPriority | null;
  kind?: TicketKind | null;
  sortOrder?: number;
}

export function updateTicket(
  ref: TicketRef,
  ticketId: string,
  body: UpdateTicketBody,
): Promise<TicketListRow> {
  return ticketJson(ticketsPath(ref, `/${ticketId}`), { method: 'PATCH', body: JSON.stringify(body) });
}

export function deleteTicket(ref: TicketRef, ticketId: string): Promise<{ ok: boolean }> {
  return ticketJson(ticketsPath(ref, `/${ticketId}`), { method: 'DELETE' });
}

export function promoteTicket(
  ref: TicketRef,
  ticketId: string,
): Promise<{ threadId: string; created: boolean }> {
  return ticketJson(ticketsPath(ref, `/${ticketId}/promote`), { method: 'POST' });
}

export function addTicketDependency(
  ref: TicketRef,
  ticketId: string,
  dependsOnTicketId: string,
): Promise<{ ok: boolean }> {
  return ticketJson(ticketsPath(ref, `/${ticketId}/dependencies`), {
    method: 'POST',
    body: JSON.stringify({ dependsOnTicketId }),
  });
}

export function removeTicketDependency(
  ref: TicketRef,
  ticketId: string,
  depId: string,
): Promise<{ ok: boolean }> {
  return ticketJson(ticketsPath(ref, `/${ticketId}/dependencies/${depId}`), { method: 'DELETE' });
}
