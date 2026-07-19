import { ChevronRight } from "lucide-react";
import { useState, useEffect } from "react";
import { MessageTime } from './MessageTime';

export function ThinkingBlock({
  text,
  streaming = false,
  time,
}: {
  text: string;
  streaming?: boolean;
  time?: string;
}) {
  // Auto-expand while the reasoning is streaming (watch it think live), then collapse it once the turn
  // finishes so the transcript stays tidy. Manual toggles between streaming-state changes are preserved —
  // the effect only re-fires when `streaming` itself flips. Persisted blocks render with streaming=false → closed.
  const [open, setOpen] = useState(streaming);
  useEffect(() => setOpen(streaming), [streaming]);
  return (
    <div className="anim-fadeUp">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-left font-mono text-[11px] italic text-faint hover:text-dim"
        >
          <ChevronRight
            size={11}
            strokeWidth={2.6}
            className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          {streaming ? 'thinking…' : 'thought'}
        </button>
        <MessageTime iso={time} tone="thinking" />
      </div>
      {open ? (
        <p
          className="mt-1.5 whitespace-pre-wrap pl-4.5 text-[12.5px] italic leading-relaxed text-dim"
          style={{ borderLeft: '2px solid var(--border)' }}
        >
          {/* trim: summarized thinking arrives with leading/trailing newlines that whitespace-pre-wrap
              would otherwise render as blank-line padding above the text; internal formatting is preserved. */}
          {text.trim()}
        </p>
      ) : null}
    </div>
  );
}
