/**
 * Wire shapes for the Atlas web console auth API.
 *
 * These are the web-safe contract types (no TypeORM / backend deps) shared between
 * the backend and the admin web. A user's password hash is never part of any of them.
 */
import type { OrgSummary } from './org.dto';

/** Minimal signed-in identity, returned as `{ user }` by login / register / refresh. */
export interface AuthSession {
  id: string;
  email: string;
  name: string | null;
}

/** Returned by `GET /auth/session` — the signed-in user plus the orgs they belong to. */
export interface CurrentUserResponse extends AuthSession {
  orgs: OrgSummary[];
}

/** Envelope returned by `POST /auth/login`, `/register`, and `/refresh`. */
export interface LoginResponse {
  user: AuthSession;
}
