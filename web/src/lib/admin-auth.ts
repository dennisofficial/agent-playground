import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Server-side admin auth gate. Call at the top of any Server Component or Server Action
 * that should be restricted to authenticated admins.
 *
 * Reads the httpOnly `access_token` cookie set by /auth/login; redirects to /admin/login
 * when absent. This is the same check the `(private)/layout.tsx` performs — use it in
 * server components that live outside that layout group (e.g. /admin/*).
 */
export async function requireAdmin(): Promise<void> {
  const cookieStore = await cookies();
  if (!cookieStore.has('access_token')) {
    redirect('/admin/login');
  }
}
