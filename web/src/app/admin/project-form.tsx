'use client';

import { useActionState } from 'react';
import { createProjectAction } from './actions';
import { IDLE } from './action-state';

const inputCls =
  'rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50';

export function ProjectForm({ tokenNames }: { tokenNames: string[] }) {
  const [state, action, pending] = useActionState(createProjectAction, IDLE);
  return (
    <form
      action={action}
      className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <h3 className="text-sm font-medium text-black dark:text-zinc-50">Register a project</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input
          name="projectId"
          required
          placeholder="project id (the room's project, e.g. customer-panel)"
          className={`${inputCls} font-mono`}
        />
        <input name="displayName" required placeholder="display name" className={inputCls} />
        <input
          name="gitUrl"
          required
          placeholder="https://github.com/owner/repo"
          className={`${inputCls} font-mono sm:col-span-2`}
        />
        <input name="defaultBranch" placeholder="base branch (default: main)" className={`${inputCls} font-mono`} />
        <select name="tokenName" defaultValue="" className={inputCls}>
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
          disabled={pending}
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {pending ? 'Registering…' : 'Register project'}
        </button>
      </div>
      {state.error ? (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{state.error}</p>
      ) : null}
      {state.ok ? <p className="mt-2 text-sm text-emerald-600">Registered.</p> : null}
    </form>
  );
}
