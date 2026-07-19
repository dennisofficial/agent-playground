'use client';

import { Spinner } from '@/components/ui/spinner';
import { JobWorkspace } from '@/features/job-workspace/job-workspace';
import { SITE_MAP } from '@/lib/site-map';
import { useGetJobQuery } from '@/redux/query/api/jobs.api';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, use, useEffect } from 'react';

export default function JobIndexPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params);
  const router = useRouter();
  const { data: job, isLoading, isError } = useGetJobQuery(jobId);

  const target = job ? (job.focusedThreadId ?? job.threadGroups[0]?.threads[0]?.id ?? null) : null;

  useEffect(() => {
    if (target) router.replace(SITE_MAP.jobs.job(jobId).thread(target)());
  }, [target, jobId, router]);

  if (isError) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h2 className="font-disp text-[16px] font-semibold text-text">Job not found</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-dim">
            That job doesn&apos;t exist or you don&apos;t have access to it.
          </p>
          <Link
            href={SITE_MAP.workspace()}
            className="mt-5 inline-block rounded-md border px-3.5 py-2 text-[12.5px] font-medium text-accent"
            style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
          >
            ← All organizations
          </Link>
        </div>
      </div>
    );
  }

  // Loading, or redirecting to the focused thread.
  if (isLoading || target) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center">
        <Spinner className="h-5 w-5 text-faint" />
      </div>
    );
  }

  // Loaded but the job has no thread to focus — render the workspace at the job level.
  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-0 items-center justify-center">
          <Spinner className="h-5 w-5 text-faint" />
        </div>
      }
    >
      {job && <JobWorkspace orgId={job.orgId} repoId={job.repoId} jobId={job.id} />}
    </Suspense>
  );
}
