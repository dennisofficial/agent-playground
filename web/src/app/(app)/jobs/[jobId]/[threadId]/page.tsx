'use client';

import { Spinner } from '@/components/ui/spinner';
import { JobWorkspace } from '@/features/job-workspace/job-workspace';
import { ROUTES } from '@/lib/routes';
import { useGetJobQuery } from '@/redux/query/api/jobs.api';
import Link from 'next/link';
import { Suspense, use } from 'react';

export default function ThreadPage({
  params,
}: {
  params: Promise<{ jobId: string; threadId: string }>;
}) {
  const { jobId } = use(params);
  const { data: job, isLoading, isError } = useGetJobQuery(jobId);

  if (isLoading) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center">
        <Spinner className="h-5 w-5 text-faint" />
      </div>
    );
  }

  if (isError || !job) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h2 className="font-disp text-[16px] font-semibold text-text">Job not found</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-dim">
            That job doesn&apos;t exist or you don&apos;t have access to it.
          </p>
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
      <JobWorkspace orgId={job.orgId} repoId={job.repoId} jobId={job.id} />
    </Suspense>
  );
}
