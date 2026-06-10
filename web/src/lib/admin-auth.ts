import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { env, ENodeEnv } from './env';

/**
 * The web-side admin gate. Server Actions are POST endpoints, not UI callbacks — without this,
 * anyone who can reach the web app would wield the server-held bearer as ambient authority. The
 * gate proves TOKEN POSSESSION: the operator pastes ADMIN_API_TOKEN once at /admin/login; it's
 * kept in an httpOnly sameSite=strict cookie (never readable by client JS) and re-validated
 * against env on the page AND inside every mutation action. Rotating the env token invalidates
 * all web sessions — intended.
 */

const COOKIE = 'admin_token';

const tokensMatch = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export async function isAdmin(): Promise<boolean> {
  // Cookies FIRST — the request-time API must be reached before any env branching, or a no-env
  // `next build` short-circuits on the env check and PRERENDERS the gate's redirect permanently.
  const presented = (await cookies()).get(COOKIE)?.value ?? '';
  const expected = env.ADMIN_API_TOKEN;
  if (!expected) return false;
  return !!presented && tokensMatch(presented, expected);
}

/** Page-side gate: bounce to the login screen. (Reading cookies also makes the route dynamic.) */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) redirect('/admin/login');
}

/** Action-side gate: a friendly error instead of a redirect mid-mutation. */
export async function assertAdmin(): Promise<string | undefined> {
  return (await isAdmin())
    ? undefined
    : 'Not signed in (or the admin token rotated) — log in again at /admin/login.';
}

export async function setAdminCookie(token: string): Promise<void> {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.NODE_ENV === ENodeEnv.PROD,
    path: '/',
  });
}

export async function clearAdminCookie(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** True when the server is missing its own ADMIN_API_TOKEN (setup incomplete). */
export function adminConfigured(): boolean {
  return !!env.ADMIN_API_TOKEN;
}

export function checkLoginToken(presented: string): boolean {
  const expected = env.ADMIN_API_TOKEN;
  return !!expected && !!presented && tokensMatch(presented, expected);
}
