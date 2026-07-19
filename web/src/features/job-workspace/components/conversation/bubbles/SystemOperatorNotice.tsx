import { Button } from "@/components/ui/button";
import { JobMessage, JobRef, ThreadApiError } from "@/lib/api/job-api";
import { useRetryTurn } from "@/lib/api/job-queries";
import { MAIN_LANE } from "@/lib/api/job-stream";
import { ChevronRight, RotateCw, Check } from "lucide-react";
import { useState, useEffect } from "react";
import Markdown from "react-markdown";
import { humanizeFailureCategory, useRetryCountdown } from "./bubbles";

export function SystemOperatorNotice({
  message,
  jobRef,
  lane,
  isOutstanding = false,
}: {
  message: JobMessage;
  jobRef: JobRef;
  lane?: string;
  /** Whether THIS failure is still the outstanding one (thread currently halted). Only then is the Resume
   *  button live; once the thread has resumed the footer shows a muted "Resumed" instead of a live CTA. */
  isOutstanding?: boolean;
}) {
  const retryable = message.meta?.retryable === true;
  const sessionLimit = message.meta?.sessionLimit === true;
  const resumeAt = typeof message.meta?.resumeAt === 'string' ? message.meta.resumeAt : undefined;
  // The friendly, classified one-liner (`summarizeTurnFailure`) — when present, it's the headline and the
  // raw `message.text` moves behind a "Details" disclosure instead of always showing verbatim.
  const summary = typeof message.meta?.summary === 'string' ? message.meta.summary : undefined;
  const categoryLabel = humanizeFailureCategory(
    typeof message.meta?.category === 'string' ? message.meta.category : undefined,
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isMain = (lane ?? MAIN_LANE) === MAIN_LANE;
  const retry = useRetryTurn(jobRef);
  // A bare (non-force) Resume within the server's manual-retry re-slam cooldown 429s (`ThreadApiError` w/
  // `retryAfterMs`) rather than succeeding — react-query lands on `isError`, so it never latches to
  // "Resumed", but the generic error hint would misread as a real failure. Track the cooldown window locally
  // so the button re-disables with a "cooling down" hint instead, and re-enables itself once it elapses.
  const [coolingUntil, setCoolingUntil] = useState<number | undefined>(undefined);
  useEffect(() => {
    const err = retry.error;
    if (err instanceof ThreadApiError && err.status === 429) {
      setCoolingUntil(Date.now() + (err.retryAfterMs ?? 0));
    }
  }, [retry.error]);
  const coolingSecs = useRetryCountdown(coolingUntil);
  const isCoolingDown = coolingSecs != null;
  // Once the cooldown window elapses, the throttled attempt's stale error must not resurface as a
  // generic "Couldn't resume" — clear it (and the cooldown marker) so the button goes back to idle.
  useEffect(() => {
    if (!isCoolingDown && coolingUntil !== undefined) {
      setCoolingUntil(undefined);
      retry.reset();
    }
  }, [isCoolingDown, coolingUntil, retry]);
  return (
    <div
      className="anim-fadeUp rounded-[9px] border"
      style={{ borderColor: 'var(--red-line)', background: 'var(--red-soft)' }}
    >
      <div
        className="flex items-center gap-2 rounded-t-[8px] px-3.5 py-2"
        style={{
          borderBottom: '1px solid var(--red-line)',
          background: 'color-mix(in srgb, var(--red) 10%, transparent)',
        }}
      >
        <span aria-hidden style={{ color: 'var(--red)', fontSize: 11, lineHeight: 1 }}>
          ⚠
        </span>
        <span
          className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: 'var(--red)' }}
        >
          System
        </span>
        {categoryLabel ? (
          <span
            className="rounded-full px-1.5 py-px font-mono text-[9.5px] font-medium uppercase tracking-wide"
            style={{
              color: 'var(--red)',
              background: 'color-mix(in srgb, var(--red) 14%, transparent)',
            }}
          >
            {categoryLabel}
          </span>
        ) : null}
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-faint">harness</span>
      </div>
      {/* Markdown body — a classified failure leads with the friendly summary and tucks the raw text behind
          a "Details" disclosure; an unclassified (older) row just renders the raw text as before. */}
      <div className="px-3.5 py-3">
        {summary ? (
          <>
            <p className="text-[13px] text-text">{summary}</p>
            <button
              type="button"
              onClick={() => setDetailsOpen((o) => !o)}
              aria-expanded={detailsOpen}
              className="mt-1.5 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-faint hover:text-dim"
            >
              <ChevronRight
                size={10}
                strokeWidth={2.6}
                className={`shrink-0 transition-transform ${detailsOpen ? 'rotate-90' : ''}`}
              />
              Details
            </button>
            {detailsOpen ? (
              <div className="mt-2 border-t pt-2.5" style={{ borderColor: 'var(--red-line)' }}>
                <Markdown>{message.text}</Markdown>
              </div>
            ) : null}
          </>
        ) : (
          <Markdown>{message.text}</Markdown>
        )}
      </div>
      {sessionLimit ? (
        <SessionLimitActions jobRef={jobRef} isMain={isMain} resumeAt={resumeAt} />
      ) : retryable ? (
        <div
          className="flex items-center gap-2 border-t px-3.5 py-2.5"
          style={{ borderColor: 'var(--red-line)' }}
        >
          {isOutstanding ? (
            <>
              <Button
                size="sm"
                loading={retry.isPending}
                loadingText="Resuming…"
                disabled={retry.isSuccess || isCoolingDown}
                onClick={() => retry.mutate(undefined)}
              >
                <RotateCw size={12} className="mr-1" />
                {retry.isSuccess ? 'Resumed' : 'Resume'}
              </Button>
              {isCoolingDown ? (
                <span className="text-[11.5px] text-faint">
                  Cooling down — try again in {coolingSecs}s.
                </span>
              ) : retry.isError ? (
                <span className="text-[11.5px] text-red">Couldn&apos;t resume. Try again.</span>
              ) : null}
            </>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-faint">
              <Check size={12} aria-hidden />
              Resumed
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
