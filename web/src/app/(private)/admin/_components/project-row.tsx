'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { ProjectRecord } from '@/lib/admin-api';
import { useUpdateProjectMutation } from '@/redux/query/api/projectApi';

const inputCls =
  'rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50';

type FormValues = {
  displayName: string;
  gitUrl: string;
  defaultBranch: string;
  tokenName: string;
};

function mutationErrorMessage(err: unknown): string {
  if (!err) return 'An error occurred';
  if (typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

export function ProjectRow({
  teamId,
  project,
  tokenNames,
}: {
  teamId: string;
  project: ProjectRecord;
  tokenNames: string[];
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [updateProject, { isLoading }] = useUpdateProjectMutation();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: {
      displayName: project.displayName,
      gitUrl: project.gitUrl,
      defaultBranch: project.defaultBranch,
      tokenName: project.tokenName ?? '',
    },
  });

  async function onSubmit(values: FormValues) {
    setDone(false);
    const result = await updateProject({
      teamId,
      projectId: project.projectId,
      dto: {
        displayName: values.displayName,
        gitUrl: values.gitUrl,
        defaultBranch: values.defaultBranch || 'main',
        tokenName: values.tokenName || null,
      },
    });
    if ('error' in result) {
      setError('root', { message: mutationErrorMessage(result.error) });
    } else {
      setDone(true);
    }
  }

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
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-900"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              {...register('displayName', { required: true })}
              className={inputCls}
            />
            <input
              {...register('defaultBranch', { required: true })}
              className={`${inputCls} font-mono`}
            />
            <input
              {...register('gitUrl', {
                required: true,
                pattern: { value: /^https?:\/\/.+/, message: 'Must be a valid URL' },
              })}
              className={`${inputCls} font-mono sm:col-span-2`}
            />
            <select {...register('tokenName')} className={inputCls}>
              <option value="">— default token —</option>
              {tokenNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={isLoading}
              className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
            >
              {isLoading ? 'Saving…' : 'Save changes'}
            </button>
          </div>
          {errors.root ? (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{errors.root.message}</p>
          ) : null}
          {done ? <p className="mt-2 text-sm text-emerald-600">Saved.</p> : null}
        </form>
      ) : null}
    </div>
  );
}
