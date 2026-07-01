'use client';

import { Suspense, use } from 'react';
import Link from 'next/link';
import { decodeJobRef, ROUTES } from '@/lib/routes';
import { JobWorkspace } from '@/features/job-workspace/job-workspace';
import { Spinner } from '@/components/ui/spinner';

/**
 * The thread workspace — navigator + work column (Conversation / Phase). The `[jobKey]` segment
 * encodes the `org/repo/thread` triple (see `routes.ts`); a malformed key shows a recover link rather
 * than crashing.
 */
export default function ThreadPage({ params }: { params: Promise<{ jobKey: string }> }) {
  const { jobKey } = use(params);
  const ref = decodeJobRef(jobKey);

  if (!ref) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h2 className="font-disp text-[16px] font-semibold text-text">Job not found</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-dim">That job link is malformed.</p>
          <Link
            href={ROUTES.workspace()}
            className="mt-5 inline-block rounded-md border px-3.5 py-2 text-[12.5px] font-medium text-accent"
            style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
          >
            ← All organizations
          </Link>
        </div>
      </div>
    );
  }

  // `JobWorkspace` reads the selected node from `?node=` via `useSearchParams`, which needs a Suspense
  // boundary (else a statically-rendered route bails to client rendering). Keep it tight — just this reader.
  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-0 items-center justify-center">
          <Spinner className="h-5 w-5 text-faint" />
        </div>
      }
    >
      <JobWorkspace orgId={ref.orgId} repoId={ref.repoId} jobId={ref.jobId} />
    </Suspense>
  );
}
