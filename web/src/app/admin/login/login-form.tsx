'use client';

import { useActionState } from 'react';
import { loginAction } from '../actions';
import { IDLE } from '../action-state';

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, IDLE);
  return (
    <form action={action} className="mt-5 flex flex-col gap-3">
      <input
        name="token"
        type="password"
        autoComplete="off"
        required
        placeholder="admin token"
        className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 font-mono text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50"
      />
      {state.error ? <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
      >
        {pending ? 'Checking…' : 'Sign in'}
      </button>
    </form>
  );
}
