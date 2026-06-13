'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { putToken } from '@/lib/admin-api';

const inputCls =
  'rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50';

type FormValues = {
  name: string;
  token: string;
  isDefault: boolean;
};

/** Add a new token or rotate an existing one (same name overwrites the value). */
export function TokenForm({ teamId, onSuccess }: { teamId: string; onSuccess: () => void }) {
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: { isDefault: false } });

  async function onSubmit(values: FormValues) {
    setDone(false);
    try {
      await putToken(teamId, {
        name: values.name,
        token: values.token,
        ...(values.isDefault ? { default: true } : {}),
      });
      reset();
      setDone(true);
      onSuccess();
    } catch (err) {
      setError('root', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <h3 className="text-sm font-medium text-black dark:text-zinc-50">Add / rotate a token</h3>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <input
          {...register('name', { required: true })}
          placeholder="name (e.g. personal)"
          className={`${inputCls} font-mono sm:w-48`}
        />
        <input
          {...register('token', { required: true })}
          type="password"
          autoComplete="off"
          placeholder="ghp_… (write-only)"
          className={`${inputCls} flex-1 font-mono`}
        />
      </div>
      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            {...register('isDefault')}
            className="accent-black dark:accent-zinc-50"
          />
          make default
        </label>
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {isSubmitting ? 'Saving…' : 'Save token'}
        </button>
      </div>
      {errors.root ? (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{errors.root.message}</p>
      ) : null}
      {done ? <p className="mt-2 text-sm text-emerald-600">Saved.</p> : null}
    </form>
  );
}
