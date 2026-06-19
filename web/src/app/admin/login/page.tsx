'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/auth';

const inputCls =
  'rounded-md border bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:text-zinc-50';

/**
 * The post-login destination. Reads `?next=` from the live URL (client-only — avoids useSearchParams
 * and its Suspense requirement) and only honors a SAME-ORIGIN relative path, so a deep-linked plan
 * URL survives the login round-trip without opening an open-redirect.
 */
function safeNextTarget(): string {
  if (typeof window === 'undefined') return '/admin';
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.includes('://')) {
    return next;
  }
  return '/admin';
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    let valid = true;
    if (!email.trim()) {
      setEmailError('Email is required');
      valid = false;
    } else {
      setEmailError(null);
    }
    if (!password) {
      setPasswordError('Password is required');
      valid = false;
    } else {
      setPasswordError(null);
    }
    if (!valid) return;

    setError(null);
    setPending(true);
    try {
      await auth.signIn(email.trim(), password);
      router.replace(safeNextTarget());
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Sign in failed. Please check your credentials.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-6 font-sans dark:bg-black">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-lg font-semibold text-black dark:text-zinc-50">Admin login</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to manage projects and GitHub tokens.
        </p>
        <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="email"
              autoComplete="email"
              className={`${inputCls} ${
                emailError
                  ? 'border-red-400 dark:border-red-600'
                  : 'border-zinc-300 dark:border-zinc-700'
              }`}
            />
            {emailError ? (
              <p className="text-xs text-red-600 dark:text-red-400">{emailError}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="password"
              autoComplete="current-password"
              className={`${inputCls} ${
                passwordError
                  ? 'border-red-400 dark:border-red-600'
                  : 'border-zinc-300 dark:border-zinc-700'
              }`}
            />
            {passwordError ? (
              <p className="text-xs text-red-600 dark:text-red-400">{passwordError}</p>
            ) : null}
          </div>
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
