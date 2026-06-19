'use client';

import { useParams } from 'next/navigation';
import { useGetPlanQuery } from '@/redux/query/api/planApi';
import { isNormalizedError } from '@/redux/query/axiosQuery';
import { PlanViewer } from './plan-viewer';

/**
 * Plan Viewer page — `/plans/:teamId/:taskId`. Renders a planned ticket as diagrams + prose instead
 * of a wall of markdown. Auth-guarded by the (viewer) layout; the Slack approval card deep-links here.
 */
export default function PlanPage() {
  const params = useParams<{ teamId: string; taskId: string }>();
  const teamId = params.teamId;
  const taskId = params.taskId;

  const { data, isLoading, error } = useGetPlanQuery(
    { teamId, taskId },
    { skip: !teamId || !taskId },
  );

  if (error) {
    const notFound = isNormalizedError(error) && error.status === 404;
    return (
      <Notice tone={notFound ? 'muted' : 'error'}>
        {notFound
          ? `No plan found for ticket #${taskId} in this workspace.`
          : `Couldn't load the plan: ${isNormalizedError(error) ? error.message : 'unknown error'}.`}
      </Notice>
    );
  }

  if (isLoading || !data) {
    return <Notice tone="muted">Loading plan…</Notice>;
  }

  return <PlanViewer plan={data} />;
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'muted' | 'error';
}) {
  const cls =
    tone === 'error'
      ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200'
      : 'border-zinc-200 bg-white text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400';
  return (
    <div className={`rounded-xl border p-6 text-sm ${cls}`}>{children}</div>
  );
}
