"use client";

import Link from "next/link";
import { TicketIcon } from "lucide-react";
import { ROUTES } from "@/lib/routes";
import type { JobRef } from "@/lib/api/job-api";
import { useJobTickets } from "@/lib/api/tickets-queries";
import type { TicketListRow } from "@/lib/api/tickets-api";
import {
  STATUS_LABEL,
  kindColor,
  priorityColor,
  statusColor,
  timeAgo,
} from "@/features/tickets/ticket-helpers";

/**
 * The "Tickets raised" detail pane — every ticket Atlas captured FROM this job (`?originJobId=`), so the
 * operator has a standing, glanceable record of out-of-scope work that survives the conversation scroll.
 * Each row links to the ticket on the repo's board (opens its drawer via `?ticket=<id>`). Kept live by
 * `useJobEvents`, which invalidates the `job-tickets` key on any `ticket_event`.
 */
export function TicketsRaisedPane({ jobRef }: { jobRef: JobRef }) {
  const { data: tickets = [], isLoading } = useJobTickets(jobRef);

  if (isLoading && tickets.length === 0) {
    return (
      <div className="px-5 py-6 text-[12.5px] text-dim">Loading tickets…</div>
    );
  }

  if (tickets.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <TicketIcon size={22} className="text-faint" />
        <p className="text-[13px] font-medium text-text">No tickets yet</p>
        <p className="max-w-xs text-[12px] leading-snug text-dim">
          When Atlas finds out-of-scope work during this job, it captures a
          ticket — they’ll show up here and as a callout in the conversation.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
        {tickets.length} raised from this job
      </p>
      {tickets.map((t) => (
        <TicketRow key={t.id} ticket={t} jobRef={jobRef} />
      ))}
    </div>
  );
}

function TicketRow({
  ticket: t,
  jobRef,
}: {
  ticket: TicketListRow;
  jobRef: JobRef;
}) {
  const href = `${ROUTES.tickets(jobRef.orgId, jobRef.repoId)}?ticket=${t.id}`;
  return (
    <Link
      href={href}
      className="block rounded-lg border border-border bg-surface px-4 py-3 transition hover:bg-surface-2"
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[12px] font-semibold text-dim">
          #{t.number}
        </span>
        <span className="min-w-0 flex-1 text-[13px] font-medium text-text">
          {t.title}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-faint">
          {timeAgo(t.createdAt)}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span
          className="rounded-full border border-border px-1.5 py-0.5 text-[9.5px] uppercase"
          style={{ color: statusColor(t.status) }}
        >
          {STATUS_LABEL[t.status]}
        </span>
        {t.kind ? (
          <span
            className="rounded-full border border-border px-1.5 py-0.5 text-[9.5px] uppercase"
            style={{ color: kindColor(t.kind) }}
          >
            {t.kind}
          </span>
        ) : null}
        {t.priority ? (
          <span
            className="rounded-full border border-border px-1.5 py-0.5 text-[9.5px] uppercase"
            style={{ color: priorityColor(t.priority) }}
          >
            {t.priority}
          </span>
        ) : null}
        {t.blocked ? (
          <span className="rounded-full border border-border px-1.5 py-0.5 text-[9.5px] uppercase text-amber">
            blocked
          </span>
        ) : null}
        {t.linkedThreadId ? (
          <span className="rounded-full border border-border px-1.5 py-0.5 text-[9.5px] uppercase text-dim">
            promoted
          </span>
        ) : null}
      </div>
    </Link>
  );
}
