'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useCreateProjectMutation } from '@/redux/query/api/projectApi';

const inputCls =
  'rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50';

type FormValues = {
  projectId: string;
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

export function ProjectForm({
  teamId,
  tokenNames,
}: {
  teamId: string;
  tokenNames: string[];
}) {
  const [done, setDone] = useState(false);
  const [createProject, { isLoading }] = useCreateProjectMutation();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<FormValues>({ defaultValues: { tokenName: '' } });

  async function onSubmit(values: FormValues) {
    setDone(false);
    const result = await createProject({
      teamId,
      dto: {
        projectId: values.projectId,
        displayName: values.displayName,
        gitUrl: values.gitUrl,
        ...(values.defaultBranch ? { defaultBranch: values.defaultBranch } : {}),
        ...(values.tokenName ? { tokenName: values.tokenName } : {}),
      },
    });
    if ('error' in result) {
      setError('root', { message: mutationErrorMessage(result.error) });
    } else {
      reset();
      setDone(true);
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <h3 className="text-sm font-medium text-black dark:text-zinc-50">Register a project</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input
          {...register('projectId', { required: true })}
          placeholder="project id (the room's project, e.g. customer-panel)"
          className={`${inputCls} font-mono`}
        />
        <input
          {...register('displayName', { required: true })}
          placeholder="display name"
          className={inputCls}
        />
        <input
          {...register('gitUrl', {
            required: true,
            pattern: { value: /^https?:\/\/.+/, message: 'Must be a valid URL' },
          })}
          placeholder="https://github.com/owner/repo"
          className={`${inputCls} font-mono sm:col-span-2`}
        />
        <input
          {...register('defaultBranch')}
          placeholder="base branch (default: main)"
          className={`${inputCls} font-mono`}
        />
        <select {...register('tokenName')} className={inputCls}>
          <option value="">— default token —</option>
          {tokenNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 flex items-center justify-end">
        <button
          type="submit"
          disabled={isLoading}
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {isLoading ? 'Registering…' : 'Register project'}
        </button>
      </div>
      {errors.root ? (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{errors.root.message}</p>
      ) : null}
      {done ? <p className="mt-2 text-sm text-emerald-600">Registered.</p> : null}
    </form>
  );
}
