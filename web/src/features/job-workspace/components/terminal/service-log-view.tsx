'use client';

import type { JobRef } from '@/lib/api/job-api';
import { useServiceLogStream } from '@/lib/api/service-log-store';
import type { ServiceInfo } from '@/lib/api/types';
import { useVirtualizer } from '@tanstack/react-virtual';
import Anser from 'anser';
import { useMemo, useRef } from 'react';
import { compensateAboveViewportResize } from '../../lib/scroll-compensation';
import { JumpToLatestButton, useTailFollow } from '../conversation/tail-follow';

/** The service pane's header subtitle — live status + cmd + pid/start/log-update facts, or why there's
 *  no marker. The leading status word mirrors the sidebar dot (running / stopped; unknown is omitted
 *  rather than shown as a confident claim). */
export function serviceHeaderSubtitle(service: ServiceInfo | null): string {
  if (!service)
    return 'no marker on disk — this process may have been stopped or the sandbox reset';
  const parts: string[] = [];
  if (service.status === 'running') parts.push('running');
  else if (service.status === 'stopped') parts.push('stopped');
  parts.push(service.cmd ? `atlas-svc · ${service.cmd}` : 'atlas-svc · supervised process');
  if (service.pid != null) parts.push(`pid ${service.pid}`);
  if (service.startedAt) parts.push(`started ${new Date(service.startedAt).toLocaleTimeString()}`);
  if (service.logUpdatedAt)
    parts.push(`log updated ${new Date(service.logUpdatedAt).toLocaleTimeString()}`);
  return parts.join(' · ');
}

const LINE_HEIGHT_PX = 19; // 11.5px mono at leading-relaxed (1.625) ≈ 18.7px, rounded

/**
 * A process the agent brought up on demand via `atlas-svc run` — its log, LIVE-tailed over SSE (see
 * `useServiceLogStream` / the backend's `log-events` endpoint), rendered in a real terminal frame with ANSI
 * colors instead of a plain `<pre>` showing raw escape codes.
 *
 * Windowed: a long-running, chatty process can accumulate tens of thousands of lines over a session (the
 * client buffer is capped — see `service-log-store.ts` — but even a few thousand lines is too much to keep
 * live in the DOM), so only the on-screen rows actually render (`@tanstack/react-virtual`, the same approach
 * `conversation.tsx` uses for the main transcript).
 */
export function ServiceLogView({ jobRef, id }: { jobRef: JobRef; id: string }) {
  const log = useServiceLogStream(jobRef, id);
  const lines = useMemo(() => (log?.content ? log.content.split('\n') : []), [log?.content]);

  // `pin` snaps the view to the bottom for the virtualized case (see useTailFollow's doc comment) —
  // assigned into a ref so the callback stays stable while still reaching the freshly-built `virtualizer`.
  const pinRef = useRef<() => void>(() => {});
  const tail = useTailFollow([lines.length], () => pinRef.current());

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => tail.scrollRef.current,
    estimateSize: () => LINE_HEIGHT_PX,
    overscan: 20,
  });

  // `shouldAdjustScrollPositionOnItemSizeChange` is a Virtualizer INSTANCE field, not a constructor
  // option — `useVirtualizer`'s options merge never copies it onto the instance, so it must be assigned
  // directly here rather than inside the options object above.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = compensateAboveViewportResize;

  pinRef.current = () => {
    const el = tail.scrollRef.current;
    if (!el) return;
    if (lines.length > 0) virtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
    requestAnimationFrame(() => {
      const e = tail.scrollRef.current;
      if (e) e.scrollTop = e.scrollHeight;
    });
  };

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="relative h-full min-h-0 flex-1">
      <div
        ref={tail.scrollRef}
        onScroll={tail.onScroll}
        onPointerOver={tail.onPointerOver}
        onPointerLeave={tail.onPointerLeave}
        className="h-full overflow-y-auto overscroll-contain [overflow-anchor:none] px-4 py-3"
        style={{ background: 'var(--term)' }}
      >
        {log === undefined ? (
          <p className="font-mono text-[11.5px]" style={{ color: 'var(--term-dim)' }}>
            Loading…
          </p>
        ) : !log.content ? (
          <p className="font-mono text-[11.5px] italic" style={{ color: 'var(--term-dim)' }}>
            (no log output yet)
          </p>
        ) : (
          <div
            className="relative w-full font-mono text-[11.5px] leading-relaxed"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((vi) => (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full whitespace-pre-wrap wrap-break-word"
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <AnsiLine line={lines[vi.index]} />
              </div>
            ))}
          </div>
        )}
        <div ref={tail.endRef} />
      </div>
      {tail.showJump ? (
        <JumpToLatestButton onClick={tail.jumpToLatest} style={{ bottom: 14 }} />
      ) : null}
    </div>
  );
}

/**
 * A STATIC `.log` file artifact (e.g. `artifacts/e2e/image-build.log`), rendered in the SAME dark terminal
 * frame with `anser`-parsed ANSI colors as a live {@link ServiceLogView} — but read top-down from a fixed
 * string, so there's no SSE tail, no tail-follow, and no jump-to-latest. Still windowed with
 * `@tanstack/react-virtual` because a context file can reach the backend's 2 MB cap (tens of thousands of
 * lines) — a plain per-line render of that would lock up the browser.
 */
export function LogFileView({ content }: { content: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => content.split('\n'), [content]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT_PX,
    overscan: 20,
  });
  // Same Cause B fix as the other virtualizers in this file: compensate above-viewport
  // re-measures during an upward scroll so content doesn't slide down (see note above).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = compensateAboveViewportResize;

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto px-4 py-3"
      style={{ background: 'var(--term)' }}
    >
      <div
        className="relative w-full font-mono text-[11.5px] leading-relaxed"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualItems.map((vi) => (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full whitespace-pre-wrap wrap-break-word"
            style={{ transform: `translateY(${vi.start}px)` }}
          >
            <AnsiLine line={lines[vi.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}

function cssColor(triple: string | null): string | undefined {
  return triple ? `rgb(${triple})` : undefined;
}

function AnsiLine({ line }: { line: string }) {
  const segments = useMemo(
    () => Anser.ansiToJson(line, { use_classes: false, remove_empty: true }),
    [line],
  );
  return (
    <>
      {segments.map((seg, i) => (
        <span
          key={i}
          style={{
            color: cssColor(seg.fg) ?? 'var(--term-fg)',
            background: cssColor(seg.bg),
            // SGR "dim"/"faint" (code 2) carries no color of its own — anser reports it as a decoration,
            // not a `fg`, so without this a de-emphasized line (e.g. Nest's pid/timestamp prefix) would
            // render at full brightness instead of faded.
            opacity: seg.decoration === 'dim' ? 0.6 : undefined,
          }}
        >
          {seg.content}
        </span>
      ))}
    </>
  );
}
