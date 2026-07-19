import { SystemTone } from "@/features/job-workspace/lib/classify";
import { JobMessage } from "@/lib/api/job-api";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import { TONE_COLOR } from "./bubbles";

export function CompactionSummaryPill({
  message,
  tone,
  summary,
}: {
  message: JobMessage;
  tone: SystemTone;
  summary: string;
}) {
  const [open, setOpen] = useState(false);
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
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: TONE_COLOR[tone] }}
        />
        <span className="min-w-0 flex-1 truncate">{message.text}</span>
        <span className="shrink-0 text-faint">{open ? 'hide' : 'inspect'}</span>
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open ? (
        <div className="border-t px-3.5 py-2.5 text-[12px]" style={{ borderColor: 'var(--hair)' }}>
          <Markdown>{summary}</Markdown>
        </div>
      ) : null}
    </div>
  );
}
