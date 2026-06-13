'use client';

import type { GithubTokenMeta } from '@/lib/admin-api';
import { useSetDefaultTokenMutation, useDeleteTokenMutation } from '@/redux/query/api/tokenApi';

function mutationErrorMessage(err: unknown): string {
  if (!err) return 'An error occurred';
  if (typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

export function TokenRow({
  teamId,
  token,
}: {
  teamId: string;
  token: GithubTokenMeta;
}) {
  const [setDefaultToken, { isLoading: settingDefault, error: setDefaultError }] =
    useSetDefaultTokenMutation();
  const [deleteToken, { isLoading: deleting, error: deleteError }] = useDeleteTokenMutation();

  const error = setDefaultError ?? deleteError;

  async function handleSetDefault() {
    await setDefaultToken({ teamId, name: token.name });
  }

  async function handleDelete() {
    if (!confirm(`Delete token "${token.name}"? Projects referencing it will block this.`)) return;
    await deleteToken({ teamId, name: token.name });
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-black dark:text-zinc-50">{token.name}</span>
          {token.isDefault ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              default
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {!token.isDefault ? (
            <button
              type="button"
              onClick={handleSetDefault}
              disabled={settingDefault}
              className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Set default
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="rounded-md border border-red-300 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
          >
            Delete
          </button>
        </div>
      </div>
      {error ? (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{mutationErrorMessage(error)}</p>
      ) : null}
    </div>
  );
}
