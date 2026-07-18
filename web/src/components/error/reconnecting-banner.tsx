'use client';

import { Spinner } from '@/components/ui/spinner';

/**
 * Non-intrusive "reconnecting" banner — shown by <ConnectivityGate> while the backend is briefly
 * unreachable, before a sustained outage escalates to the persistent red <OfflineIndicator> pill. Fixed,
 * top-center, accent-toned (not red — it's not a full outage) and token-driven so it threads the active
 * daylight/terminal/warm theme. Transform-only entrance (handoff §5) and `pointer-events-none` so it
 * never blocks the workspace beneath it.
 */
export function ReconnectingBanner() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="anim-fadeUp pointer-events-none fixed left-1/2 top-3 z-50 -translate-x-1/2"
    >
      <div
        className="font-mono flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[11.5px] font-medium tracking-wide shadow-[var(--shadow-card)] backdrop-blur"
        style={{
          color: 'var(--accent-2)',
          borderColor: 'color-mix(in srgb, var(--accent) 38%, transparent)',
          background: 'color-mix(in srgb, var(--accent) 9%, var(--surface))',
        }}
      >
        <Spinner className="h-3 w-3" />
        Reconnecting…
      </div>
    </div>
  );
}
