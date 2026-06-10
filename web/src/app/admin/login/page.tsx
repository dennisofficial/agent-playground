import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  await connection(); // request-bound: the already-signed-in redirect must never prerender
  if (await isAdmin()) redirect('/admin');
  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-6 font-sans dark:bg-black">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-lg font-semibold text-black dark:text-zinc-50">Admin login</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Paste the <code className="font-mono">ADMIN_API_TOKEN</code> to manage projects and
          GitHub tokens.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
