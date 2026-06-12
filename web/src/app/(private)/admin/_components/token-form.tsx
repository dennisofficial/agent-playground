'use client';

import { useState } from 'react';
import { putToken } from '@/lib/admin-api';

const inputCls =
  'rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50';

/** Add a new token or rotate an existing one (same name overwrites the value). */
export function TokenForm({ teamId, onSuccess }: { teamId: string; onSuccess: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const str = (key: string) => String(fd.get(key) ?? '').trim();
    setError(null);
    setDone(false);
    setPending(true);
    try {
      await putToken(teamId, {
        name: str('name'),
        token: str('token'),
        ...(fd.get('default') ? { default: true } : {}),
      });
      setDone(true);
      (e.target as HTMLFormElement).reset();
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <h3 className="text-sm font-medium text-black dark:text-zinc-50">Add / rotate a token</h3>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <input
          name="name"
          required
          placeholder="name (e.g. personal)"
          className={`${inputCls} font-mono sm:w-48`}
        />
        <input
          name="token"
          type="password"
          autoComplete="off"
          required
          placeholder="ghp_… (write-only)"
          className={`${inputCls} flex-1 font-mono`}
        />
      </div>
      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" name="default" className="accent-black dark:accent-zinc-50" />
          make default
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {pending ? 'Saving…' : 'Save token'}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : null}
      {done ? <p className="mt-2 text-sm text-emerald-600">Saved.</p> : null}
    </form>
  );
}
