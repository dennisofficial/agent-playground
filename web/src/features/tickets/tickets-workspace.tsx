"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Link2, Lock, Plus, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  useAllRepos,
  useCreateTicket,
  useDeleteTicket,
  usePromoteTicket,
  useRepoTicketEvents,
  useTickets,
  useUpdateTicket,
} from "@/lib/api/tickets-queries";
import { findSimilarTickets, type TicketListRow } from "@/lib/api/tickets-api";
import {
  BOARD_COLUMNS,
  PRIORITY_RANK,
  STATUS_LABEL,
  cap,
  isAtlasCaptured,
  kindColor,
  passesFilter,
  priorityColor,
  statusColor,
  timeAgo,
} from "./ticket-helpers";
import { TicketDetailModal } from "./ticket-detail-modal";
import { TicketFormModal, type TicketFormValue } from "./ticket-form-modal";

type View = "board" | "backlog";
type Filter = "all" | "blocked" | "atlas" | "urgent";
type ModalState =
  | { mode: "create" }
  | { mode: "edit"; ticket: TicketListRow }
  | null;

const FILTERS: Array<{ v: Filter; label: string }> = [
  { v: "all", label: "All" },
  { v: "blocked", label: "Blocked" },
  { v: "atlas", label: "Atlas-captured" },
  { v: "urgent", label: "Urgent" },
];

/** The per-repo tickets board + backlog. Repo context comes from the route; the repo sidebar switches it. */
export function TicketsWorkspace({
  orgId,
  repoId,
}: {
  orgId: string;
  repoId: string;
}) {
  const { repos } = useAllRepos();
  const meta = repos.find((r) => r.repo.id === repoId);
  const { data: tickets = [], isLoading } = useTickets(orgId, repoId);
  useRepoTicketEvents(orgId, repoId);

  const create = useCreateTicket(orgId, repoId);
  const update = useUpdateTicket(orgId, repoId);
  const del = useDeleteTicket(orgId, repoId);
  const promote = usePromoteTicket(orgId, repoId);

  const [view, setView] = useState<View>("board");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  // Deep-link: `?ticket=<id>` (e.g. the job-workspace "Atlas raised a ticket" callout) opens that
  // ticket's drawer directly. Honor it whenever the param is present — once the ticket is in `tickets`
  // the drawer resolves; navigating between different `?ticket=` targets re-opens accordingly.
  const searchParams = useSearchParams();
  const deepLinkTicket = searchParams.get("ticket");
  useEffect(() => {
    if (deepLinkTicket) setDrawerId(deepLinkTicket);
  }, [deepLinkTicket]);

  const boardCount = useMemo(
    () =>
      tickets.filter((t) => (BOARD_COLUMNS as string[]).includes(t.status))
        .length,
    [tickets],
  );
  const backlogCount = useMemo(
    () => tickets.filter((t) => t.status === "backlog").length,
    [tickets],
  );
  const nextNumber = useMemo(
    () => tickets.reduce((a, t) => Math.max(a, t.number), 0) + 1,
    [tickets],
  );
  const drawerRow = drawerId
    ? (tickets.find((t) => t.id === drawerId) ?? null)
    : null;

  function submitForm(value: TicketFormValue) {
    const body = {
      title: value.title,
      body: value.body || null,
      priority: value.priority || null,
      kind: value.kind || null,
    };
    if (modal?.mode === "edit") {
      update.mutate(
        { ticketId: modal.ticket.id, body },
        { onSuccess: () => setModal(null) },
      );
    } else {
      // A new ticket lands in the backlog — jump there so it's visible (it won't appear on the board).
      create.mutate(body, {
        onSuccess: () => {
          setModal(null);
          setView("backlog");
        },
      });
    }
  }

  function onPromote(ticketId: string) {
    promote.mutate(ticketId, {
      onSuccess: () => {
        setDrawerId(null);
        setView("board");
      },
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {/* repo header */}
      <div className="flex flex-none items-center gap-3.5 px-[26px] pt-4">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-[9px] w-[9px] flex-none rounded-[2px]"
            style={{ background: "var(--accent)" }}
          />
          <span className="font-mono text-[12px] text-dim">
            {meta?.orgName ?? "—"}
          </span>
          <span className="text-border-2">/</span>
          <span className="font-mono text-[12px] font-semibold text-text">
            {meta?.repo.name ?? repoId}
          </span>
        </div>
      </div>

      {/* toolbar */}
      <div className="flex flex-none flex-wrap items-center gap-3 px-[26px] pb-3 pt-3.5">
        <Segmented
          options={[
            { v: "board", label: "Board", count: boardCount },
            { v: "backlog", label: "Backlog", count: backlogCount },
          ]}
          value={view}
          onChange={(v) => setView(v as View)}
        />
        <div className="relative flex w-full items-center sm:w-auto">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 text-faint"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title or #number"
            className="h-8 w-full rounded-md border border-border bg-surface pl-[30px] pr-3 text-[12px] text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-[var(--accent-soft)] sm:w-[220px]"
          />
        </div>
        <div className="flex items-center gap-[7px]">
          {FILTERS.map((f) => (
            <button
              key={f.v}
              type="button"
              onClick={() => setFilter(f.v)}
              className="rounded-full border px-[11px] py-1 font-mono text-[10px] font-semibold transition"
              style={
                filter === f.v
                  ? {
                      background: "var(--accent-soft)",
                      borderColor: "var(--accent-line)",
                      color: "var(--accent)",
                    }
                  : { borderColor: "var(--border)", color: "var(--dim)" }
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <div
          className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1"
          style={{ background: "var(--surface)" }}
        >
          <span
            className="pulse-dot h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--green)" }}
          />
          <span className="font-mono text-[9.5px] text-dim">live</span>
        </div>
        <button
          type="button"
          onClick={() => setModal({ mode: "create" })}
          className="flex h-8 items-center gap-1.5 rounded-md px-3.5 text-[12px] font-semibold text-white transition hover:brightness-105"
          style={{
            background:
              "linear-gradient(145deg, var(--accent), var(--accent-2))",
            boxShadow: "0 4px 12px var(--accent-soft)",
          }}
        >
          <Plus size={13} strokeWidth={2.4} /> New ticket
        </button>
      </div>

      {/* body */}
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-faint">
          Loading tickets…
        </div>
      ) : view === "board" ? (
        <Board
          tickets={tickets}
          q={q}
          filter={filter}
          boardCount={boardCount}
          backlogCount={backlogCount}
          onOpen={setDrawerId}
          onGoBacklog={() => setView("backlog")}
        />
      ) : (
        <Backlog
          tickets={tickets}
          q={q}
          filter={filter}
          showCancelled={showCancelled}
          onToggleCancelled={() => setShowCancelled((s) => !s)}
          onOpen={setDrawerId}
          onPromote={onPromote}
          onDelete={(id) => del.mutate(id)}
          promotingId={promote.isPending ? (promote.variables as string) : null}
          onNew={() => setModal({ mode: "create" })}
        />
      )}

      {drawerRow ? (
        <TicketDetailModal
          orgId={orgId}
          repoId={repoId}
          row={drawerRow}
          promoting={promote.isPending}
          onClose={() => setDrawerId(null)}
          onEdit={() => setModal({ mode: "edit", ticket: drawerRow })}
          onPromote={() => onPromote(drawerRow.id)}
          onDelete={() =>
            del.mutate(drawerRow.id, { onSuccess: () => setDrawerId(null) })
          }
          onOpenTicket={(id) => setDrawerId(id)}
        />
      ) : null}

      {modal ? (
        <TicketFormModal
          mode={modal.mode}
          number={modal.mode === "edit" ? modal.ticket.number : undefined}
          nextNumber={nextNumber}
          initial={
            modal.mode === "edit"
              ? {
                  title: modal.ticket.title,
                  body: modal.ticket.body ?? "",
                  priority: modal.ticket.priority ?? "",
                  kind: modal.ticket.kind ?? "",
                }
              : undefined
          }
          busy={create.isPending || update.isPending}
          onSubmit={submitForm}
          onClose={() => setModal(null)}
          onCheckSimilar={(v) =>
            findSimilarTickets(
              { orgId, repoId },
              { title: v.title, body: v.body || null },
            )
          }
          onOpenSimilar={(id) => {
            setModal(null);
            setDrawerId(id);
          }}
        />
      ) : null}
    </div>
  );
}

// ── Board ─────────────────────────────────────────────────────────────────────────────────────────

function Board({
  tickets,
  q,
  filter,
  boardCount,
  backlogCount,
  onOpen,
  onGoBacklog,
}: {
  tickets: TicketListRow[];
  q: string;
  filter: Filter;
  boardCount: number;
  backlogCount: number;
  onOpen: (id: string) => void;
  onGoBacklog: () => void;
}) {
  if (boardCount === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-[430px] text-center">
          <EmptyIcon />
          <div className="font-disp text-[17px] font-semibold text-text">
            Nothing on the board yet
          </div>
          <div className="mt-2 text-[12.5px] leading-relaxed text-dim">
            {backlogCount > 0
              ? `You have ${backlogCount} ticket${backlogCount === 1 ? "" : "s"} waiting in the backlog. Atlas commits them to Todo when they're ready — or promote one to start a job now.`
              : "Atlas captures tickets into the backlog as you talk, then commits them here when they’re ready to work."}
          </div>
          {backlogCount > 0 ? (
            <button
              type="button"
              onClick={onGoBacklog}
              className="mt-4 inline-flex h-[33px] items-center gap-1.5 rounded-md border border-border bg-surface px-4 text-[12px] font-semibold text-dim transition hover:bg-surface-2"
            >
              View backlog ({backlogCount})
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-[26px] pb-[22px]">
      <div className="flex h-full min-w-min gap-3.5">
        {BOARD_COLUMNS.map((col) => {
          const all = tickets.filter((t) => t.status === col);
          const cards = all.filter((t) => passesFilter(t, q, filter));
          const threadDriven = col === "in_progress" || col === "in_review";
          return (
            <div key={col} className="flex w-[270px] flex-none flex-col">
              <div className="flex flex-none items-center gap-2 px-1 pb-2.5 pt-2">
                <span
                  className="h-2 w-2 flex-none rounded-full"
                  style={{
                    background: statusColor(col),
                    boxShadow:
                      col === "in_progress" ? "0 0 7px var(--accent)" : "none",
                  }}
                />
                <span className="text-[12px] font-semibold text-text">
                  {STATUS_LABEL[col]}
                </span>
                <span className="font-mono text-[10px] text-faint">
                  {all.length}
                </span>
                <div className="flex-1" />
                {threadDriven ? (
                  <span className="rounded border border-border px-1.5 py-px font-mono text-[8px] tracking-[0.06em] text-faint">
                    JOB-DRIVEN
                  </span>
                ) : null}
              </div>
              <div
                className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto rounded-md p-0.5 pb-2.5"
                style={
                  col === "done"
                    ? {
                        background:
                          "color-mix(in srgb, var(--surface-2) 55%, transparent)",
                      }
                    : undefined
                }
              >
                {cards.map((t) => (
                  <BoardCard key={t.id} t={t} onOpen={() => onOpen(t.id)} />
                ))}
                {cards.length === 0 ? (
                  <div className="px-2.5 py-3.5 text-center text-[10.5px] italic leading-relaxed text-faint">
                    {col === "todo"
                      ? "Committed tickets land here, waiting for a job."
                      : col === "done"
                        ? "Merged tickets collect here."
                        : "A job moves a ticket here when it reaches this stage."}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BoardCard({ t, onOpen }: { t: TicketListRow; onOpen: () => void }) {
  const dim = t.status === "done" || t.status === "cancelled";
  const atlas = isAtlasCaptured(t);
  const showMeta = t.blocked || !!t.linkedThreadId;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-left transition hover:border-border-2 hover:shadow-[0_3px_12px_rgba(0,0,0,0.07)]"
      style={{
        opacity: dim ? 0.6 : 1,
        boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-faint">#{t.number}</span>
        {t.kind ? (
          <span
            className="rounded-[3px] border border-border-2 px-1 py-px font-mono text-[8px] font-bold tracking-[0.07em]"
            style={{ color: kindColor(t.kind) }}
          >
            {t.kind.toUpperCase()}
          </span>
        ) : null}
        <div className="flex-1" />
        {t.priority ? (
          <span
            className="flex items-center gap-1 font-mono text-[8.5px] font-semibold"
            style={{ color: priorityColor(t.priority) }}
          >
            <span
              className="h-1.5 w-1.5 rounded-[2px]"
              style={{ background: priorityColor(t.priority) }}
            />
            {cap(t.priority)}
          </span>
        ) : null}
      </div>
      <div className="text-[13px] font-semibold leading-snug tracking-[-0.005em] text-text">
        {t.title}
      </div>
      {showMeta ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {t.blocked ? (
            <span
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[8.5px] font-semibold"
              style={{
                color: "var(--red)",
                background: "var(--red-soft)",
                borderColor: "var(--red-line)",
              }}
            >
              <Lock size={9} /> blocked by{" "}
              {t.blockedBy ? `#${t.blockedBy}` : "—"}
            </span>
          ) : null}
          {t.linkedThreadId ? (
            <span
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[8.5px] font-semibold"
              style={{
                color: "var(--accent)",
                background: "var(--accent-soft)",
                borderColor: "var(--accent-line)",
              }}
            >
              <Link2 size={9} /> in job
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="mt-px flex items-center gap-1.5">
        <Marker atlas={atlas} />
        <span className="font-mono text-[8.5px] text-faint">
          {atlas ? "Atlas" : "You"}
        </span>
        <div className="flex-1" />
        <span className="font-mono text-[8.5px] text-faint">
          {timeAgo(t.updatedAt)}
        </span>
      </div>
    </button>
  );
}

// ── Backlog ───────────────────────────────────────────────────────────────────────────────────────

function Backlog({
  tickets,
  q,
  filter,
  showCancelled,
  onToggleCancelled,
  onOpen,
  onPromote,
  onDelete,
  promotingId,
  onNew,
}: {
  tickets: TicketListRow[];
  q: string;
  filter: Filter;
  showCancelled: boolean;
  onToggleCancelled: () => void;
  onOpen: (id: string) => void;
  onPromote: (id: string) => void;
  onDelete: (id: string) => void;
  promotingId: string | null;
  onNew: () => void;
}) {
  const backlog = tickets.filter((t) => t.status === "backlog");
  const rows = backlog
    .filter((t) => passesFilter(t, q, filter))
    .sort(
      (a, b) =>
        (PRIORITY_RANK[a.priority ?? "low"] ?? 9) -
        (PRIORITY_RANK[b.priority ?? "low"] ?? 9),
    );
  const cancelled = tickets.filter((t) => t.status === "cancelled");

  if (backlog.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-[460px] text-center">
          <EmptyIcon lines />
          <div className="font-disp text-[17px] font-semibold text-text">
            Your backlog is empty
          </div>
          <div className="mt-2 text-[12.5px] leading-relaxed text-dim">
            Atlas drops tickets here while you talk in a job —{" "}
            <span className="text-text">
              &quot;do A now, push B for later.&quot;
            </span>{" "}
            They wait in the backlog until you commit them to the board or
            promote one into its own job. You can also add one yourself.
          </div>
          <button
            type="button"
            onClick={onNew}
            className="mt-4 inline-flex h-[34px] items-center gap-1.5 rounded-md px-4 text-[12.5px] font-semibold text-white transition hover:brightness-105"
            style={{
              background:
                "linear-gradient(145deg, var(--accent), var(--accent-2))",
              boxShadow: "0 4px 12px var(--accent-soft)",
            }}
          >
            <Plus size={13} strokeWidth={2.4} /> New ticket
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-[26px] pb-6">
      <div className="max-w-[880px]">
        <div className="flex items-center gap-2 px-0.5 pb-2.5 pt-1">
          <span className="font-mono text-[9px] tracking-[0.14em] text-faint">
            TRIAGE · {rows.length}
          </span>
          <div
            className="h-px flex-1"
            style={{ background: "var(--border)" }}
          />
          <span className="text-[10px] text-faint">
            Promote to start work, or let Atlas commit it to the board.
          </span>
        </div>
        <div className="flex flex-col gap-2">
          {rows.map((t) => (
            <BacklogRow
              key={t.id}
              t={t}
              promoting={promotingId === t.id}
              onOpen={() => onOpen(t.id)}
              onPromote={() => onPromote(t.id)}
              onDelete={() => onDelete(t.id)}
            />
          ))}
        </div>

        {cancelled.length > 0 ? (
          <>
            <button
              type="button"
              onClick={onToggleCancelled}
              className="mt-5 flex w-full items-center gap-2 rounded-sm px-0.5 py-2 text-left transition hover:bg-surface-2"
            >
              <ArrowRight
                size={11}
                strokeWidth={2.6}
                className="text-faint transition-transform"
                style={{ transform: showCancelled ? "rotate(90deg)" : "none" }}
              />
              <span className="font-mono text-[9px] tracking-[0.14em] text-faint">
                CANCELLED · {cancelled.length}
              </span>
              <div
                className="h-px flex-1"
                style={{ background: "var(--border)" }}
              />
            </button>
            {showCancelled ? (
              <div className="mt-1 flex flex-col gap-1.5">
                {cancelled.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onOpen(t.id)}
                    className="flex items-center gap-2.5 rounded-md border border-border bg-surface px-3.5 py-2.5 text-left"
                    style={{ opacity: 0.6 }}
                  >
                    <span className="grid h-4 w-4 flex-none place-items-center rounded-full border border-border-2 font-mono text-[9px] text-faint">
                      ×
                    </span>
                    <span className="font-mono text-[10px] text-faint">
                      #{t.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-dim line-through">
                      {t.title}
                    </span>
                    <span className="font-mono text-[8.5px] text-faint">
                      cancelled · {timeAgo(t.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function BacklogRow({
  t,
  promoting,
  onOpen,
  onPromote,
  onDelete,
}: {
  t: TicketListRow;
  promoting: boolean;
  onOpen: () => void;
  onPromote: () => void;
  onDelete: () => void;
}) {
  const atlas = isAtlasCaptured(t);
  const body = (t.body ?? "").replace(/\n+/g, " ").trim();
  return (
    <div
      onClick={onOpen}
      className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-surface px-3.5 py-3 transition hover:border-border-2 hover:shadow-[0_3px_12px_rgba(0,0,0,0.07)]"
      style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}
    >
      <div className="flex w-[42px] flex-none flex-col items-center gap-1.5 pt-0.5">
        {t.priority ? (
          <span
            className="grid h-[18px] w-[18px] place-items-center rounded-[5px]"
            style={{ background: priorityColor(t.priority) }}
            title={cap(t.priority)}
          >
            <span className="h-1.5 w-1.5 rounded-[2px] bg-white" />
          </span>
        ) : (
          <span
            className="h-[18px] w-[18px] rounded-[5px] border-[1.4px] border-dashed border-border-2"
            title="No priority"
          />
        )}
        <span className="font-mono text-[8px] uppercase tracking-[0.04em] text-faint">
          {(t.priority ?? "—").slice(0, 3)}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-faint">#{t.number}</span>
          {t.kind ? (
            <span
              className="rounded-[3px] border border-border-2 px-1 py-px font-mono text-[8px] font-bold tracking-[0.07em]"
              style={{ color: kindColor(t.kind) }}
            >
              {t.kind.toUpperCase()}
            </span>
          ) : null}
          {t.blocked ? (
            <span
              className="inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-[8.5px] font-semibold"
              style={{
                color: "var(--red)",
                background: "var(--red-soft)",
                borderColor: "var(--red-line)",
              }}
            >
              blocked by {t.blockedBy ? `#${t.blockedBy}` : "—"}
            </span>
          ) : null}
        </div>
        <div className="mt-1.5 text-[13.5px] font-semibold leading-snug tracking-[-0.005em] text-text">
          {t.title}
        </div>
        {body ? (
          <div className="mt-1 truncate text-[11.5px] leading-relaxed text-dim">
            {body}
          </div>
        ) : (
          <div className="mt-1 text-[11px] italic text-faint">
            No description
          </div>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <Marker atlas={atlas} />
          <span className="font-mono text-[8.5px] text-faint">
            {atlas ? "Atlas" : "You"} · {timeAgo(t.createdAt)}
          </span>
          {t.origin?.threadTitle ? (
            <span className="font-mono text-[8.5px] text-faint">
              · from {t.origin.threadTitle}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-none flex-col gap-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPromote();
          }}
          disabled={promoting}
          className="flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-[10.5px] font-semibold transition hover:brightness-105 disabled:opacity-70"
          style={{
            background: "var(--accent-soft)",
            borderColor: "var(--accent-line)",
            color: "var(--accent)",
          }}
        >
          <ArrowRight size={11} /> {promoting ? "Promoting…" : "Promote"}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="flex h-[26px] items-center justify-center whitespace-nowrap rounded-md border border-border px-3 text-[10.5px] font-medium text-faint transition hover:bg-surface-2 hover:text-text"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ── shared bits ─────────────────────────────────────────────────────────────────────────────────

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ v: T; label: string; count?: number }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-border p-[3px]"
      style={{ background: "var(--surface-2)" }}
    >
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            "flex items-center gap-1.5 rounded px-3 py-[5px] text-[11.5px] font-medium transition",
            value === o.v ? "text-text" : "text-dim hover:text-text",
          )}
          style={
            value === o.v
              ? {
                  background: "var(--surface)",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                }
              : undefined
          }
        >
          {o.label}
          {o.count !== undefined ? (
            <span className="font-mono text-[9px] text-faint">{o.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function Marker({ atlas }: { atlas: boolean }) {
  return atlas ? (
    <span
      className="h-[9px] w-[9px] flex-none rounded-[1.5px] border-[1.3px] border-accent"
      style={{ transform: "rotate(45deg)" }}
    />
  ) : (
    <span
      className="h-[9px] w-[9px] flex-none rounded-full border border-border-2"
      style={{ background: "var(--surface-3)" }}
    />
  );
}

function EmptyIcon({ lines }: { lines?: boolean }) {
  return (
    <div
      className="mx-auto mb-4 grid h-[54px] w-[54px] place-items-center rounded-lg border border-border bg-surface"
      style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--faint)"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {lines ? (
          <path d="M4 6h16M4 12h16M4 18h10" />
        ) : (
          <>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18M9 9v11M15 9v11" />
          </>
        )}
      </svg>
    </div>
  );
}
