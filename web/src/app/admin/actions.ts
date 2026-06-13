'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Server Action — clears the httpOnly auth cookies and redirects to the login page.
 * Wired into the logout form on admin pages that live outside the (private) layout group.
 */
export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete('access_token');
  cookieStore.delete('refresh_token');
  redirect('/admin/login');
}
