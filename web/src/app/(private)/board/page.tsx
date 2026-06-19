'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { BoardTaskView } from '@workspace/shared';
import { useGetTenantsQuery } from '@/redux/query/api/memoryApi';
import { useGetBoardQuery } from '@/redux/query/api/planApi';
import { statusBadgeClass } from '@/components/plan/status';

const selectCls =
  'rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50';

/**
 * Plan board — a browsable index of every team-board task, each linking to its Plan Viewer. The
 * entry point for reading plans when you don't have the Slack deep link. Mirrors the Memory Viewer's
 * workspace-picker + RTK Query pattern.
 */
export default function BoardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const teamParam = searchParams.get('team') ?? undefined;

  const { data: tenants, isLoading: tenantsLoading, error: tenantsError } = useGetTenantsQuery();
  const selectedTeamId = tenants?.find((t) => t.id === teamParam)?.id ?? tenants?.[0]?.id;

  const {
    data: tasks,
    isFetching,
    error: boardError,
  } = useGetBoardQuery({ teamId: selectedTeamId! }, { skip: !selectedTeamId });

  if (tenantsError || boardError) {
    return <BackendError err={tenantsError ?? boardError} />;
  }
  if (tenantsLoading) {
    return <Muted>Loading…</Muted>;
  }
  if (!tenants || tenants.length === 0) {
    return <Muted>No workspaces registered yet.</Muted>;
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <label htmlFor="board-workspace" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Workspace
        </label>
        <select
          id="board-workspace"
          value={selectedTeamId ?? ''}
          onChange={(e) => router.push(`/board?team=${encodeURIComponent(e.target.value)}`)}
          className={`${selectCls} min-w-[180px]`}
        >
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {isFetching && <span className="text-xs text-zinc-400 dark:text-zinc-500">Loading…</span>}
      </div>

      {!tasks || tasks.length === 0 ? (
        <Muted>No board tasks in this workspace yet.</Muted>
      ) : (
        <ul className="flex flex-col gap-2">
          {tasks.map((t) => (
            <li key={t.id}>
              <TaskRow teamId={selectedTeamId!} task={t} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskRow({ teamId, task }: { teamId: string; task: BoardTaskView }) {
  return (
    <a
      href={`/plans/${encodeURIComponent(teamId)}/${task.id}`}
      className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
    >
      <span className="w-10 shrink-0 text-sm text-zinc-400 dark:text-zinc-500">#{task.id}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
        {task.title}
      </span>
      <span className="hidden shrink-0 text-xs text-zinc-400 dark:text-zinc-500 sm:inline">{task.project}</span>
      {task.assignee && (
        <span className="hidden shrink-0 text-xs capitalize text-zinc-500 dark:text-zinc-400 sm:inline">
          {task.assignee}
        </span>
      )}
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(task.status)}`}>
        {task.status.replace(/_/g, ' ')}
      </span>
    </a>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-zinc-500 dark:text-zinc-400">{children}</p>;
}

function BackendError({ err }: { err: unknown }) {
  const message =
    err && typeof err === 'object' && 'message' in err
      ? String((err as { message: unknown }).message)
      : String(err);
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
      <h2 className="font-semibold">Backend admin API unreachable</h2>
      <p className="mt-2 font-mono text-xs">{message}</p>
    </section>
  );
}
