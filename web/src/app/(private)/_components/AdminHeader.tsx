'use client';

import { useRouter } from 'next/navigation';
import { auth } from '@/lib/auth';

/**
 * Admin chrome header — client island for the interactive Log out action.
 * Imported by the (private) Server Component layout.
 */
export default function AdminHeader() {
  const router = useRouter();

  function handleSignOut() {
    auth.signOut();
    router.replace('/admin/login');
  }

  return (
    <header className="mb-10 flex items-center justify-between">
      <div>
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          Agent Playground — Admin
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          GitHub workspaces for the AI employees
        </p>
      </div>
      <div className="flex items-center gap-3">
        <a
          href="/admin/memory"
          className="text-sm text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Memory viewer
        </a>
        <button
          type="button"
          onClick={handleSignOut}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Log out
        </button>
      </div>
    </header>
  );
}
