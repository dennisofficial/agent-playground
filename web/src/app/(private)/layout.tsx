import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import AdminHeader from './_components/AdminHeader';

/**
 * Server-side route-protection layout for all routes under (private)/.
 *
 * Reads the httpOnly `access_token` cookie before the page renders.
 * If absent, issues a server redirect to /admin/login — no JS required,
 * no client flash. The client-side 401 → refresh cycle (in admin-api.ts)
 * handles token expiry after the initial render.
 *
 * The header chrome (title + Log out button) is a client island so the
 * interactive sign-out action has access to useRouter.
 */
export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const hasSession = cookieStore.has('access_token');

  if (!hasSession) {
    redirect('/admin/login');
  }

  return (
    <main className="flex flex-1 justify-center bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <div className="w-full max-w-3xl">
        <AdminHeader />
        {children}
      </div>
    </main>
  );
}
