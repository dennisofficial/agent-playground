"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { decodeJobRef, ROUTES, threadHref } from "@/lib/routes";
import { usePipeline } from "@/lib/api/job-queries";
import { pipelineFocusedThreadId } from "@/lib/api/types";
import { Spinner } from "@/components/ui/spinner";

/** How long to poll for a not-yet-resolved `focused_thread_id` before offering a manual recovery link. */
const STUCK_AFTER_MS = 15_000;

/**
 * The job redirect shell. A job link (`/workspace/:jobKey`) carries no thread, so this resolves the job's
 * server-authoritative `focused_thread_id` (d4) from the pipeline read model and `router.replace()`s to the
 * routed thread (`/workspace/:jobKey/:threadId`). A malformed key shows a recover link; while the pointer
 * resolves it shows a spinner. The bootstrap that seeds `focused_thread_id` normally completes before the
 * create-job response returns, but polls (rather than fetching once) and offers a manual reload past
 * `STUCK_AFTER_MS` so a slow or failed bootstrap never leaves this page spinning forever with no way out.
 */
export default function JobRedirectPage({
  params,
}: {
  params: Promise<{ jobKey: string }>;
}) {
  const { jobKey } = use(params);
  const router = useRouter();
  // Stable per key so the redirect effect doesn't re-fire on every render (a fresh decode object each time
  // would loop `router.replace`).
  const ref = useMemo(() => decodeJobRef(jobKey), [jobKey]);
  // Poll while the pointer hasn't resolved yet — this page has no SSE subscription of its own to
  // otherwise learn a bootstrap finished (the effect below unmounts this page once it lands, so the
  // interval never outlives its usefulness).
  const { data: pipeline } = usePipeline(
    ref ?? { orgId: "", repoId: "", jobId: "" },
    3_000,
  );
  const focusedThreadId = pipelineFocusedThreadId(pipeline);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (ref && focusedThreadId) {
      router.replace(threadHref(ref, focusedThreadId));
    }
  }, [ref, focusedThreadId, router]);

  useEffect(() => {
    if (!ref || focusedThreadId) return;
    setStuck(false);
    const timer = setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [ref, focusedThreadId]);

  if (!ref) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h2 className="font-disp text-[16px] font-semibold text-text">
            Job not found
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-dim">
            That job link is malformed.
          </p>
          <Link
            href={ROUTES.workspace()}
            className="mt-5 inline-block rounded-md border px-3.5 py-2 text-[12.5px] font-medium text-accent"
            style={{
              background: "var(--accent-soft)",
              borderColor: "var(--accent-line)",
            }}
          >
            ← All organizations
          </Link>
        </div>
      </div>
    );
  }

  if (stuck) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h2 className="font-disp text-[16px] font-semibold text-text">
            Still setting up this job
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-dim">
            This is taking longer than expected. It may still be finishing up
            — try reloading.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-block rounded-md border px-3.5 py-2 text-[12.5px] font-medium text-accent"
            style={{
              background: "var(--accent-soft)",
              borderColor: "var(--accent-line)",
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 items-center justify-center">
      <Spinner className="h-5 w-5 text-faint" />
    </div>
  );
}
