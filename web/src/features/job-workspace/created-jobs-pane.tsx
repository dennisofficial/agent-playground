'use client';

import { StatusPie } from '@/components/ui/badges';
import type { CreatedJobRow, JobRef } from '@/lib/api/job-api';
import { useJobCreatedJobs } from '@/lib/api/job-queries';
import { STATUS_META } from '@/lib/api/status';
import { threadHref } from '@/lib/routes';
import { GitFork, GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react';
import Link from 'next/link';

/**
 * The "Created jobs" detail pane — every job Atlas spawned FROM this one (`GET …/jobs/:jobId/created`), so
 * the operator has a standing record of the work this job fanned out into. Each row links straight to the
 * child's own workspace (same org/repo — a job never spawns cross-repo).
 */
export function CreatedJobsPane({ jobRef }: { jobRef: JobRef }) {
  const { data: children = [], isLoading } = useJobCreatedJobs(jobRef);

  if (isLoading && children.length === 0) {
    return <div className="px-5 py-6 text-[12.5px] text-dim">Loading…</div>;
  }

  if (children.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <GitFork size={22} className="text-faint" />
        <p className="text-[13px] font-medium text-text">No jobs spawned yet</p>
        <p className="max-w-xs text-[12px] leading-snug text-dim">
          When this job kicks off follow-up work, the new jobs show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
        {children.length} spawned from this job
      </p>
      {children.map((c) => (
        <CreatedJobItem key={c.id} job={c} jobRef={jobRef} />
      ))}
    </div>
  );
}

function CreatedJobItem({ job, jobRef }: { job: CreatedJobRow; jobRef: JobRef }) {
  const meta = STATUS_META[job.status];
  const href = threadHref(job.id);
  return (
    <Link
      href={href}
      className="block rounded-lg border border-border bg-surface px-4 py-3 transition hover:bg-surface-2"
    >
      <div className="flex items-center gap-2">
        <StatusPie status={job.status} size={13} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">
          {job.title || 'Untitled job'}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span
          className="rounded-full border border-border px-1.5 py-0.5 font-mono text-[9.5px] uppercase"
          style={{ color: meta.color }}
        >
          {meta.label}
        </span>
        {job.prState ? <PrStateChip state={job.prState} /> : null}
      </div>
    </Link>
  );
}

/** A compact PR-state chip (icon + word), reusing the GitHub color convention (green/amber/purple/red) the
 *  navigator header and sidebar already follow — see `prGlyph` in `badges.tsx`. */
function PrStateChip({ state }: { state: string }) {
  const { Icon, color, label } =
    state === 'merged'
      ? { Icon: GitMerge, color: 'var(--purple)', label: 'merged' }
      : state === 'closed'
        ? { Icon: GitPullRequestClosed, color: 'var(--red)', label: 'closed' }
        : { Icon: GitPullRequest, color: 'var(--green)', label: 'open' };
  return (
    <span className="flex items-center gap-1 font-mono text-[9.5px] uppercase" style={{ color }}>
      <Icon size={10} />
      {label}
    </span>
  );
}
