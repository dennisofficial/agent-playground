'use client';

import { useActionState, useState } from 'react';
import type { ProjectRecord } from '@/lib/admin-api';
import { updateProjectAction } from './actions';
import { IDLE } from './action-state';

const inputCls =
  'rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50';

export function ProjectRow({
  project,
  tokenNames,
}: {
  project: ProjectRecord;
  tokenNames: string[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(updateProjectAction, IDLE);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium text-black dark:text-zinc-50">
              {project.projectId}
            </span>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">{project.displayName}</span>
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
            {project.gitUrl} · base {project.defaultBranch} · token{' '}
            {project.tokenName ?? '(default)'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {open ? 'Close' : 'Edit'}
        </button>
      </div>

      {open ? (
        <form action={action} className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-900">
          <input type="hidden" name="projectId" value={project.projectId} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              name="displayName"
              defaultValue={project.displayName}
              required
              className={inputCls}
            />
            <input
              name="defaultBranch"
              defaultValue={project.defaultBranch}
              required
              className={`${inputCls} font-mono`}
            />
            <input
              name="gitUrl"
              defaultValue={project.gitUrl}
              required
              className={`${inputCls} font-mono sm:col-span-2`}
            />
            <select name="tokenName" defaultValue={project.tokenName ?? ''} className={inputCls}>
              <option value="">— default token —</option>
              {tokenNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
            >
              {pending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
          {state.error ? (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{state.error}</p>
          ) : null}
          {state.ok ? <p className="mt-2 text-sm text-emerald-600">Saved.</p> : null}
        </form>
      ) : null}
    </div>
  );
}
