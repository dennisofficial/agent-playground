"use client";

import { useEffect } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Link2,
  MessageSquare,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { threadHref } from "@/lib/routes";
import { useTicket } from "@/lib/api/tickets-queries";
import type { TicketLite, TicketListRow } from "@/lib/api/tickets-api";
import { Overlay } from "./ticket-form-modal";
import {
  STATUS_LABEL,
  cap,
  isAtlasCaptured,
  kindColor,
  priorityColor,
  statusColor,
  timeAgo,
} from "./ticket-helpers";

/**
 * The ticket detail drawer (centered modal). Header status/kind/priority; the thread link or a promote
 * CTA; description; advisory dependencies (blocked-by / blocks); provenance; edit/delete. Deps come from
 * the detail fetch; the passed `row` renders the header instantly while that loads.
 */
export function TicketDetailModal({
  orgId,
  repoId,
  row,
  promoting,
  onClose,
  onEdit,
  onPromote,
  onDelete,
  onOpenTicket,
}: {
  orgId: string;
  repoId: string;
  row: TicketListRow;
  promoting?: boolean;
  onClose: () => void;
  onEdit: () => void;
  onPromote: () => void;
  onDelete: () => void;
  onOpenTicket: (ticketId: string) => void;
}) {
  const { data: detail } = useTicket(orgId, repoId, row.id);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const atlas = isAtlasCaptured(row);
  const linkedThreadId = detail?.linkedThreadId ?? row.linkedThreadId;
  const dependsOn = detail?.dependsOn ?? [];
  const blocks = detail?.blocks ?? [];
  const blocked = detail?.blocked ?? row.blocked;
  const hasOrigin = !!row.origin?.threadTitle || !!row.origin?.decisionSummary;

  return (
    <Overlay onClose={onClose}>
      <div
        className="anim-pop flex max-h-full w-[520px] max-w-full flex-col overflow-hidden rounded-lg border border-border"
        style={{
          background: "var(--panel)",
          boxShadow: "var(--shadow-palette)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        {/* header */}
        <div className="flex-none border-b border-border px-5 pb-3.5 pt-4">
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-[11px] text-faint">
              #{row.number}
            </span>
            <span
              className="inline-flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.05em]"
              style={{ color: statusColor(row.status) }}
            >
              <span
                className="h-[7px] w-[7px] rounded-full"
                style={{ background: statusColor(row.status) }}
              />
              {STATUS_LABEL[row.status]}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-md border border-border text-dim transition hover:bg-surface-2 hover:text-text"
              aria-label="Close"
            >
              <X size={13} />
            </button>
          </div>
          <div className="mt-2.5 font-disp text-[18px] font-semibold leading-tight text-text">
            {row.title}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {row.kind ? (
              <Tag color={kindColor(row.kind)} mono>
                {row.kind.toUpperCase()}
              </Tag>
            ) : null}
            {row.priority ? (
              <Tag color={priorityColor(row.priority)} mono dot>
                {cap(row.priority)}
              </Tag>
            ) : (
              <span className="rounded-md border border-dashed border-border-2 px-[7px] py-0.5 font-mono text-[9px] font-semibold text-faint">
                no priority
              </span>
            )}
            <div className="flex-1" />
            <span className="inline-flex items-center gap-1.5 font-mono text-[9px] text-faint">
              <Marker atlas={atlas} />
              {atlas ? "Captured by Atlas" : "Created by you"}
            </span>
          </div>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-[22px] pt-[18px]">
          {linkedThreadId ? (
            <Link
              href={threadHref({ orgId, repoId, jobId: linkedThreadId })}
              className="mb-4 flex items-center gap-2.5 rounded-md border px-3 py-2.5 transition hover:brightness-[0.99]"
              style={{
                borderColor: "var(--accent-line)",
                background: "var(--accent-soft)",
              }}
            >
              <Link2 size={15} className="text-accent" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-semibold text-accent">
                  Working in job
                </div>
                <div className="truncate text-[12.5px] font-semibold text-text">
                  {row.title}
                </div>
              </div>
              <span className="flex-none font-mono text-[10px] text-accent">
                Open ↗
              </span>
            </Link>
          ) : (
            <div className="mb-4">
              <button
                type="button"
                onClick={onPromote}
                disabled={promoting}
                className="flex h-[38px] w-full items-center justify-center gap-2 rounded-md text-[12.5px] font-semibold text-white transition hover:brightness-105 disabled:opacity-70"
                style={{
                  background:
                    "linear-gradient(145deg, var(--accent), var(--accent-2))",
                }}
              >
                <ArrowRight size={14} />
                {promoting ? "Promoting…" : "Promote to job"}
              </button>
              <div className="mt-2 text-center text-[10.5px] leading-relaxed text-faint">
                Spins up a working job (sandbox · branch · PR) that starts on
                this ticket. The job then drives its status.
              </div>
            </div>
          )}

          <SectionLabel>Description</SectionLabel>
          {row.body ? (
            <div
              className="whitespace-pre-wrap rounded-md border border-border px-3.5 py-3 text-[12.5px] leading-relaxed text-text"
              style={{ background: "var(--surface-2)" }}
            >
              {row.body}
            </div>
          ) : (
            <div
              className="rounded-md border border-dashed border-border-2 px-3.5 py-3 text-[12px] italic text-faint"
              style={{ background: "var(--surface-2)" }}
            >
              No description yet. Edit the ticket to add context for Atlas to
              pick up.
            </div>
          )}

          {dependsOn.length > 0 || blocks.length > 0 ? (
            <>
              <div className="mb-2 mt-5 flex items-center gap-2">
                <SectionLabel inline>Dependencies</SectionLabel>
                {blocked ? (
                  <span
                    className="rounded-md border px-1.5 py-px font-mono text-[8.5px] font-semibold"
                    style={{
                      color: "var(--red)",
                      background: "var(--red-soft)",
                      borderColor: "var(--red-line)",
                    }}
                  >
                    BLOCKED
                  </span>
                ) : null}
              </div>
              {dependsOn.length > 0 ? (
                <>
                  <div className="mb-1.5 text-[10px] text-dim">Blocked by</div>
                  <div className="mb-3 flex flex-col gap-1.5">
                    {dependsOn.map((d) => (
                      <DepRow
                        key={d.id}
                        dep={d}
                        onClick={() => onOpenTicket(d.id)}
                      />
                    ))}
                  </div>
                </>
              ) : null}
              {blocks.length > 0 ? (
                <>
                  <div className="mb-1.5 text-[10px] text-dim">Blocks</div>
                  <div className="flex flex-col gap-1.5">
                    {blocks.map((d) => (
                      <DepRow
                        key={d.id}
                        dep={d}
                        onClick={() => onOpenTicket(d.id)}
                      />
                    ))}
                  </div>
                </>
              ) : null}
              <div className="mt-2 text-[10px] italic leading-relaxed text-faint">
                Dependencies are advisory — nothing moves automatically when a
                blocker resolves.
              </div>
            </>
          ) : null}

          {hasOrigin ? (
            <>
              <SectionLabel className="mt-5">Provenance</SectionLabel>
              <div
                className="flex flex-col gap-2 rounded-md border border-border px-3.5 py-3"
                style={{
                  background: "var(--surface-2)",
                  borderLeft: "2px solid var(--accent)",
                }}
              >
                {row.origin?.threadTitle ? (
                  <div className="flex items-start gap-2">
                    <MessageSquare
                      size={13}
                      className="mt-px flex-none text-faint"
                    />
                    <div className="text-[11.5px] leading-relaxed text-dim">
                      Captured from job{" "}
                      <span className="font-semibold text-text">
                        {row.origin.threadTitle}
                      </span>
                    </div>
                  </div>
                ) : null}
                {row.origin?.decisionSummary ? (
                  <div className="flex items-start gap-2">
                    <span className="flex-none text-[12px]">🔒</span>
                    <div className="text-[11.5px] leading-relaxed text-dim">
                      Diverged from decision:{" "}
                      <span className="text-text">
                        {row.origin.decisionSummary}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          <div className="mt-5 flex items-center gap-2 font-mono text-[9px] text-faint">
            <span>created {timeAgo(row.createdAt)}</span>
            <span className="text-border-2">·</span>
            <span>updated {timeAgo(row.updatedAt)}</span>
          </div>
        </div>

        {/* footer */}
        <div className="flex flex-none items-center gap-2.5 border-t border-border px-5 py-3.5">
          <button
            type="button"
            onClick={onEdit}
            className="flex h-[34px] items-center gap-2 rounded-md border border-border px-4 text-[12px] font-semibold text-dim transition hover:bg-surface-2 hover:text-text"
          >
            <Pencil size={13} /> Edit
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onDelete}
            className="flex h-[34px] items-center gap-2 rounded-md border px-4 text-[12px] font-semibold transition hover:brightness-105"
            style={{
              color: "var(--red)",
              borderColor: "color-mix(in srgb, var(--red) 40%, transparent)",
            }}
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function DepRow({ dep, onClick }: { dep: TicketLite; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-2 text-left transition hover:border-border-2"
    >
      <span
        className="h-[7px] w-[7px] flex-none rounded-full"
        style={{ background: statusColor(dep.status) }}
      />
      <span className="font-mono text-[9.5px] text-faint">#{dep.number}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text">
        {dep.title}
      </span>
      <span
        className="font-mono text-[8.5px] uppercase tracking-[0.04em]"
        style={{ color: statusColor(dep.status) }}
      >
        {STATUS_LABEL[dep.status]}
      </span>
    </button>
  );
}

function SectionLabel({
  children,
  inline,
  className,
}: {
  children: React.ReactNode;
  inline?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`font-mono text-[9px] tracking-[0.14em] text-faint ${inline ? "" : "mb-2"} ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

function Tag({
  children,
  color,
  mono,
  dot,
}: {
  children: React.ReactNode;
  color: string;
  mono?: boolean;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border border-border-2 px-[7px] py-0.5 ${mono ? "font-mono" : ""} text-[9px] font-semibold`}
      style={{ color }}
    >
      {dot ? (
        <span
          className="h-1.5 w-1.5 rounded-[2px]"
          style={{ background: color }}
        />
      ) : null}
      {children}
    </span>
  );
}

function Marker({ atlas }: { atlas: boolean }) {
  return atlas ? (
    <span
      className="h-[9px] w-[9px] rounded-[1.5px] border-[1.3px] border-accent"
      style={{ transform: "rotate(45deg)" }}
    />
  ) : (
    <span
      className="h-[9px] w-[9px] rounded-full border border-border-2"
      style={{ background: "var(--surface-3)" }}
    />
  );
}
