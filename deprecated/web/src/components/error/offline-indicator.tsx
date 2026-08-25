'use client';

import { Spinner } from '@/components/ui/spinner';

/**
 * Persistent "disconnected" pill — shown by <ConnectivityGate> while the backend has been unreachable
 * long enough to count as a sustained outage. Same fixed, top-center, `pointer-events-none` shape as
 * <ReconnectingBanner> but toned with the muted brick `--red` token (matching <ServerUnreachable>'s
 * outage color language) to read as a real outage rather than a transient blip. The connectivity store
 * keeps probing underneath, so this clears itself the moment the backend self-heals to `online`.
 */
export function OfflineIndicator() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="anim-fadeUp pointer-events-none fixed left-1/2 top-3 z-50 -translate-x-1/2"
    >
      <div
        className="font-mono flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[11.5px] font-medium tracking-wide shadow-(--shadow-card) backdrop-blur"
        style={{
          color: 'var(--red)',
          borderColor: 'var(--red-line)',
          background: 'color-mix(in srgb, var(--red) 9%, var(--surface))',
        }}
      >
        <Spinner className="h-3 w-3" />
        Disconnected — reconnecting…
      </div>
    </div>
  );
}
