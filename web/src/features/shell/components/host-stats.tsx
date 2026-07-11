"use client";

import { useEffect, useRef, useState } from "react";
import { Boxes, Server } from "lucide-react";
import { cn } from "@/lib/cn";
import { useHostStats, type HostStats } from "@/lib/api/host-stats";

const FRESHNESS_STALE_MS = 15_000;
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

function thresholdColor(pct: number): string {
  if (pct >= 90) return "var(--red)";
  if (pct >= 70) return "var(--amber)";
  return "var(--green)";
}

/** Friendly size scaling up to TB (1024 base). GB/TB keep one decimal unless the value is a whole number. */
function humanizeBytes(bytes: number): string {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const unit = BYTE_UNITS[unitIndex];
  if (unit === "GB" || unit === "TB") {
    const rounded = Math.round(value * 10) / 10;
    const display = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${display} ${unit}`;
  }
  return `${Math.round(value)} ${unit}`;
}

/** "14d 3h" once past a day, "3h 12m" under a day, "12m" under an hour. */
function humanizeUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) {
    const hours = Math.floor((seconds % 86_400) / 3_600);
    return `${days}d ${hours}h`;
  }
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) {
    const minutes = Math.floor((seconds % 3_600) / 60);
    return `${hours}h ${minutes}m`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m`;
}

function timeAgo(iso: string | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function isFresh(iso: string | undefined, now: number = Date.now()): boolean {
  if (!iso) return false;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return false;
  return now - then <= FRESHNESS_STALE_MS;
}

function Divider() {
  return <span className="h-4 w-px bg-hair" />;
}

function Chip({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="flex flex-col items-start justify-center px-2 leading-tight">
      <span className="text-[8.5px] font-bold uppercase tracking-[0.07em] text-faint">{label}</span>
      <span
        className={cn("font-mono text-[11px] font-semibold tabular-nums", !color && "text-faint")}
        style={color ? { color } : undefined}
      >
        {value}
      </span>
    </span>
  );
}

function ContainerChip({ value, color }: { value: string; color?: string }) {
  return (
    <span className="flex flex-row items-center gap-[5px] px-2">
      <Boxes className="h-[11px] w-[11px] text-faint" />
      <span
        className={cn("font-mono text-[11px] font-semibold tabular-nums", color ? undefined : "text-faint")}
        style={color ? { color } : undefined}
      >
        {value}
      </span>
    </span>
  );
}

function ChipsTrigger({
  data,
  open,
  onToggle,
}: {
  data: HostStats | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label="Host stats"
      onClick={onToggle}
      disabled={!data}
      className={cn(
        "hidden h-8 items-center rounded-[4px] border border-transparent px-1 transition md:flex",
        data && "hover:bg-surface-2",
        !data && "opacity-60",
        open && "border-border bg-surface-2",
      )}
    >
      <Chip
        label="CPU"
        value={data ? `${Math.round(data.cpu.usagePct)}%` : "—"}
        color={data ? thresholdColor(data.cpu.usagePct) : undefined}
      />
      <Divider />
      <Chip
        label="RAM"
        value={data ? `${Math.round(data.memory.usagePct)}%` : "—"}
        color={data ? thresholdColor(data.memory.usagePct) : undefined}
      />
      <Divider />
      <Chip
        label="Disk"
        value={data ? `${Math.round(data.disk.usagePct)}%` : "—"}
        color={data ? thresholdColor(data.disk.usagePct) : undefined}
      />
      <Divider />
      <ContainerChip
        value={data ? String(data.containers.running) : "—"}
        color={data ? "var(--dim)" : undefined}
      />
    </button>
  );
}

function MiniTrigger({
  data,
  open,
  onToggle,
}: {
  data: HostStats | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const color = data ? thresholdColor(data.cpu.usagePct) : "var(--faint)";
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label="Host stats"
      onClick={onToggle}
      disabled={!data}
      className={cn(
        "flex h-8 items-center gap-[7px] rounded-full border border-border bg-surface-2 px-2.5 md:hidden",
        !data && "opacity-60",
      )}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{
          background: color,
          boxShadow: data ? `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)` : undefined,
        }}
      />
      <span
        className={cn(
          "font-mono text-[10.5px] font-semibold tabular-nums",
          data ? "text-dim" : "text-faint",
        )}
      >
        {data ? `${Math.round(data.cpu.usagePct)}%` : "—"}
      </span>
    </button>
  );
}

function StatRow({
  label,
  value,
  pct,
  color,
  caption,
}: {
  label: string;
  value: string;
  pct: number;
  color: string;
  caption?: string;
}) {
  return (
    <div className="flex flex-col gap-[11px]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-[7px] text-[11px] text-dim">
          <span className="h-1.5 w-1.5 rounded-[2px]" style={{ background: color }} />
          {label}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-faint">{value}</span>
      </div>
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }}
        />
      </div>
      {caption ? <div className="mt-1 text-[10px] text-faint">{caption}</div> : null}
    </div>
  );
}

function SecondaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-dim">{label}</span>
      <span className="font-mono text-[10px] tabular-nums text-faint">{value}</span>
    </div>
  );
}

function HostStatsPanel({ data }: { data: HostStats }) {
  const containerPct = data.containers.total > 0 ? (data.containers.running / data.containers.total) * 100 : 0;
  const fresh = isFresh(data.sampledAt);

  return (
    <div
      role="dialog"
      aria-label="Host stats"
      className="absolute right-0 top-[calc(100%+8px)] z-30 w-64 rounded-[9px] border border-border bg-surface-2 p-3.5 shadow-lg"
    >
      <div className="mb-2.5 flex items-center gap-[7px] border-b border-border pb-2.5 text-[11.5px] font-medium text-dim">
        <Server className="h-[13px] w-[13px]" />
        Host — atlas-box
      </div>

      <div className="flex flex-col gap-[11px]">
        <StatRow
          label="CPU"
          value={`${Math.round(data.cpu.usagePct)}%`}
          pct={data.cpu.usagePct}
          color={thresholdColor(data.cpu.usagePct)}
        />
        <StatRow
          label="Memory"
          value={`${Math.round(data.memory.usagePct)}%`}
          pct={data.memory.usagePct}
          color={thresholdColor(data.memory.usagePct)}
          caption={`${humanizeBytes(data.memory.usedBytes)} / ${humanizeBytes(data.memory.totalBytes)}`}
        />
        <StatRow
          label="Disk"
          value={`${Math.round(data.disk.usagePct)}%`}
          pct={data.disk.usagePct}
          color={thresholdColor(data.disk.usagePct)}
          caption={`${humanizeBytes(data.disk.usedBytes)} / ${humanizeBytes(data.disk.totalBytes)}`}
        />
        <StatRow
          label="Containers"
          value={`${data.containers.running} / ${data.containers.total}`}
          pct={containerPct}
          color="var(--green)"
          caption={`${data.containers.running} running / ${data.containers.total} total`}
        />
      </div>

      <div className="mt-[11px] flex flex-col gap-[7px] border-t border-border pt-2.5">
        <SecondaryRow label="Load avg" value={data.cpu.loadAvg.map((n) => n.toFixed(2)).join(" / ")} />
        <SecondaryRow label="Uptime" value={humanizeUptime(data.host.uptimeSeconds)} />
        <SecondaryRow
          label="Docker disk"
          value={data.dockerDisk ? humanizeBytes(data.dockerDisk.usedBytes) : "—"}
        />
      </div>

      <div className="mt-3 flex items-center gap-[7px] border-t border-border pt-2.5">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: fresh ? "var(--green)" : "var(--amber)" }}
        />
        <span className="font-mono text-[10px] text-faint">Updated {timeAgo(data.sampledAt) ?? "recently"}</span>
      </div>
    </div>
  );
}

/**
 * Top-bar host-stats widget — 4 primary chips (CPU/RAM/disk/containers) on desktop+tablet collapsing to
 * a single mini indicator on mobile, both opening the SAME full-metric panel. Ancillary chrome: never
 * throws, and simply dims/skeletons while the snapshot is loading or unreachable.
 */
export function HostStats() {
  const { data } = useHostStats();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (!data) return;
    setOpen((v) => !v);
  };

  return (
    <div ref={rootRef} className="relative flex items-center">
      <ChipsTrigger data={data} open={open} onToggle={toggle} />
      <MiniTrigger data={data} open={open} onToggle={toggle} />
      {open && data ? <HostStatsPanel data={data} /> : null}
    </div>
  );
}
