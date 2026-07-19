import { SeedType, toneOf } from "@/features/job-workspace/lib/classify";
import { JobMessage } from "@/lib/api/job-api";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import { KNOWN_SEED_TYPES, seedTypePresentation, TONE_COLOR } from "./bubbles";

export function SystemNoticeRow({ message }: { message: JobMessage }) {
  const [open, setOpen] = useState(false);
  const meta = message.meta ?? {};
  const seedType =
    typeof meta.seedType === 'string' &&
    (KNOWN_SEED_TYPES as readonly string[]).includes(meta.seedType)
      ? (meta.seedType as SeedType)
      : null;
  const presentation = seedType ? seedTypePresentation(seedType) : null;
  const tone = presentation?.tone ?? toneOf(message.text ?? '');
  // The full raw payload delivered to Atlas, when the row stored one that differs from the label.
  const fullBody = (meta.fullBody as string | undefined) ?? message.text;
  const Icon = presentation?.icon ?? null;
  return (
    <div
      className="anim-fadeUp flex flex-col self-stretch rounded-md border"
      style={{
        borderColor: 'var(--hair)',
        background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2.5 px-3.5 py-1.5 text-left font-mono text-[10px] text-dim"
      >
        {Icon ? (
          <Icon size={11} className="shrink-0" style={{ color: TONE_COLOR[tone] }} />
        ) : (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: TONE_COLOR[tone] }}
          />
        )}
        <span className="shrink-0 uppercase tracking-wide text-faint">
          {presentation?.label ?? 'system'}
        </span>
        <span className="min-w-0 flex-1 truncate">{message.text}</span>
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open ? (
        <div className="border-t px-3.5 py-2.5 text-[12px]" style={{ borderColor: 'var(--hair)' }}>
          <Markdown>{fullBody}</Markdown>
        </div>
      ) : null}
    </div>
  );
}
