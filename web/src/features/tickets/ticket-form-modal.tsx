"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import type {
  TicketKind,
  TicketPriority,
  TicketSimilarRow,
} from "@/lib/api/tickets-api";
import { cap, kindColor, priorityColor, statusColor } from "./ticket-helpers";

export interface TicketFormValue {
  title: string;
  body: string;
  priority: TicketPriority | "";
  kind: TicketKind | "";
}

const PRIORITIES: Array<{ v: TicketPriority | ""; label: string }> = [
  { v: "", label: "None" },
  { v: "low", label: "Low" },
  { v: "medium", label: "Medium" },
  { v: "high", label: "High" },
  { v: "urgent", label: "Urgent" },
];

const KINDS: Array<{ v: TicketKind | ""; label: string }> = [
  { v: "", label: "None" },
  { v: "feature", label: "FEATURE" },
  { v: "bug", label: "BUG" },
  { v: "chore", label: "CHORE" },
];

/**
 * Create / edit a ticket. On create it lands in the backlog (captured by you); on edit only metadata
 * changes (status is driven by Atlas & threads). Presentational — the parent owns the mutation.
 */
export function TicketFormModal({
  mode,
  number,
  nextNumber,
  initial,
  busy,
  onSubmit,
  onClose,
  onCheckSimilar,
  onOpenSimilar,
}: {
  mode: "create" | "edit";
  number?: number;
  nextNumber?: number;
  initial?: Partial<TicketFormValue>;
  busy?: boolean;
  onSubmit: (value: TicketFormValue) => void;
  onClose: () => void;
  /**
   * Semantic dedup check (create mode). The first "Create" click runs it; if it returns matches, they're
   * shown and the button becomes "Create anyway" (a second click actually files the ticket). Omit to
   * disable the check. Editing the title/description clears the shown matches so they're re-checked.
   */
  onCheckSimilar?: (value: {
    title: string;
    body: string;
  }) => Promise<TicketSimilarRow[]>;
  /** Open a surfaced related ticket (closes this modal, opens that ticket's drawer). */
  onOpenSimilar?: (ticketId: string) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [priority, setPriority] = useState<TicketPriority | "">(
    initial?.priority ?? "",
  );
  const [kind, setKind] = useState<TicketKind | "">(initial?.kind ?? "");
  // Dedup state (create mode): `similar === null` = not yet checked; `[]`/rows = checked (rows shown).
  const [similar, setSimilar] = useState<TicketSimilarRow[] | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSubmit = title.trim().length > 0 && !busy && !checking;
  // Whether matches were surfaced and not yet dismissed by an edit — drives the "Create anyway" label.
  const showingSimilar = mode === "create" && !!similar && similar.length > 0;

  const doSubmit = () =>
    onSubmit({ title: title.trim(), body: body.trim(), priority, kind });

  const submit = async () => {
    if (!canSubmit) return;
    // Edit mode, no checker, or matches already surfaced → file it. Otherwise run the dedup check first.
    if (mode !== "create" || !onCheckSimilar || similar !== null) {
      doSubmit();
      return;
    }
    setChecking(true);
    try {
      const matches = await onCheckSimilar({
        title: title.trim(),
        body: body.trim(),
      });
      setSimilar(matches);
      if (matches.length === 0) doSubmit(); // nothing related → create straight away
    } catch {
      // Fail-soft: a dedup-check error must never block ticket creation.
      setSimilar([]);
      doSubmit();
    } finally {
      setChecking(false);
    }
  };

  // Any edit to the dedup inputs invalidates surfaced matches → re-check on the next Create click.
  const changeTitle = (v: string) => {
    setTitle(v);
    if (similar !== null) setSimilar(null);
  };
  const changeBody = (v: string) => {
    setBody(v);
    if (similar !== null) setSimilar(null);
  };

  return (
    <Overlay onClose={onClose}>
      <div
        className="anim-pop w-[540px] max-w-[92vw] overflow-hidden rounded-lg border border-border"
        style={{
          background: "var(--panel)",
          boxShadow: "var(--shadow-palette)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="flex items-center gap-2 px-[22px] pt-[18px]">
          <div className="font-disp text-[16px] font-semibold text-text">
            {mode === "edit" ? `Edit ticket #${number}` : "New ticket"}
          </div>
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

        <div className="flex flex-col gap-[15px] px-[22px] pb-5 pt-4">
          <Labeled label="Title" required>
            <input
              autoFocus
              value={title}
              onChange={(e) => changeTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder="What needs doing?"
              className="h-[38px] w-full rounded-md border border-border bg-surface px-3 text-[13px] text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-[var(--accent-soft)]"
            />
          </Labeled>

          <Labeled label="Description" hint="· markdown context for Atlas">
            <textarea
              value={body}
              onChange={(e) => changeBody(e.target.value)}
              placeholder="Context, acceptance criteria, links…"
              className="h-[104px] w-full resize-none rounded-md border border-border bg-surface px-3 py-2.5 text-[12.5px] leading-relaxed text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-[var(--accent-soft)]"
            />
          </Labeled>

          <div className="flex gap-[18px]">
            <div className="flex-1">
              <FieldLabel>Priority</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {PRIORITIES.map((p) => (
                  <ChipToggle
                    key={p.v || "none"}
                    label={p.label}
                    on={priority === p.v}
                    color={p.v ? priorityColor(p.v) : "var(--dim)"}
                    onClick={() => setPriority(p.v)}
                  />
                ))}
              </div>
            </div>
            <div className="flex-1">
              <FieldLabel>Kind</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {KINDS.map((k) => (
                  <ChipToggle
                    key={k.v || "none"}
                    label={k.label}
                    on={kind === k.v}
                    color={k.v ? kindColor(k.v) : "var(--dim)"}
                    onClick={() => setKind(k.v)}
                  />
                ))}
              </div>
            </div>
          </div>

          {showingSimilar ? (
            <SimilarPanel rows={similar!} onOpen={onOpenSimilar} />
          ) : null}
        </div>

        <div
          className="flex items-center gap-2.5 border-t border-border px-[22px] py-3.5"
          style={{ background: "var(--surface-2)" }}
        >
          <div className="font-mono text-[9.5px] text-faint">
            {mode !== "create"
              ? "Editing metadata · status is driven by Atlas & jobs"
              : showingSimilar
                ? `${similar!.length} possible duplicate${similar!.length === 1 ? "" : "s"} — review above`
                : `Lands in the backlog · #${nextNumber ?? "—"} · captured by you`}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="grid h-[34px] place-items-center rounded-md border border-border px-4 text-[12px] font-semibold text-dim transition hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="grid h-[34px] place-items-center rounded-md px-[18px] text-[12px] font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed"
            style={
              canSubmit
                ? {
                    background: showingSimilar
                      ? "linear-gradient(145deg, var(--amber, #b45309), var(--accent-2))"
                      : "linear-gradient(145deg, var(--accent), var(--accent-2))",
                  }
                : {
                    background: "var(--surface-3)",
                    color: "var(--faint)",
                    opacity: 0.7,
                  }
            }
          >
            {mode === "edit"
              ? "Save changes"
              : checking
                ? "Checking…"
                : showingSimilar
                  ? "Create anyway"
                  : "Create ticket"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

export function Overlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-[60] grid place-items-center p-8"
      style={{ background: "rgba(0,0,0,0.34)" }}
      onMouseDown={onClose}
    >
      {children}
    </div>
  );
}

function Labeled({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold text-dim">
        {label}
        {required ? <span className="text-accent"> *</span> : null}
        {hint ? <span className="font-normal text-faint"> {hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-[7px] text-[11px] font-semibold text-dim">
      {children}
    </div>
  );
}

/**
 * The dedup panel: tickets already on the board that look like near-duplicates of what's being typed.
 * Shown after the first "Create" click when the semantic check returns matches — the operator can open
 * one (to update it instead) or proceed via "Create anyway".
 */
function SimilarPanel({
  rows,
  onOpen,
}: {
  rows: TicketSimilarRow[];
  onOpen?: (ticketId: string) => void;
}) {
  return (
    <div
      className="rounded-md border px-3 py-2.5"
      style={{
        borderColor: "var(--amber-line, var(--border-2))",
        background: "var(--amber-soft, var(--surface-2))",
      }}
    >
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold text-text">
          One of these may already cover this
        </span>
        <span className="font-mono text-[9px] text-faint">
          · {rows.length} related
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen?.(r.id)}
            className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-left transition hover:border-border-2"
          >
            <span className="font-mono text-[10px] text-faint">#{r.number}</span>
            {r.kind ? (
              <span
                className="rounded-[3px] border border-border-2 px-1 py-px font-mono text-[8px] font-bold tracking-[0.07em]"
                style={{ color: kindColor(r.kind) }}
              >
                {r.kind.toUpperCase()}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text">
              {r.title}
            </span>
            <span
              className="rounded-full px-1.5 py-px font-mono text-[8.5px] font-semibold"
              style={{ color: statusColor(r.status) }}
              title={cap(r.status)}
            >
              {r.status}
            </span>
            <span className="font-mono text-[9px] text-faint">
              {Math.round(r.sim * 100)}%
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ChipToggle({
  label,
  on,
  color,
  onClick,
}: {
  label: string;
  on: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "select-none rounded-md border px-[9px] py-1 font-mono text-[9.5px] font-semibold transition",
      )}
      style={
        on
          ? { background: color, borderColor: color, color: "#fff" }
          : { background: "transparent", borderColor: "var(--border-2)", color }
      }
    >
      {label}
    </button>
  );
}
