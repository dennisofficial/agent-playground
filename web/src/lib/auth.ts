'use client';

import { Auth, type AuthState } from '@workspace/auth';
import { EAuthMode, env } from './env';

export type { AuthState };

/**
 * The auth surface the Atlas console consumes. It is a thin superset of the real `@workspace/auth`
 * (`signIn` / `register` / `signOut` / `initialize` / `onAuthStateChanged` / `currentAuthState`) plus
 * the two design flows the backend doesn't expose yet (`signInWithGoogle`, `requestPasswordReset`).
 *
 * Two implementations conform to it: a `localStorage` STUB (today's default — there is no `/auth/*`
 * backend) and a REAL adapter wrapping `new Auth(...)`. `lib/auth.ts` picks one from
 * `NEXT_PUBLIC_AUTH_MODE`, so flipping to real auth is a one-env change (see BACKEND_GAPS.md).
 */
export interface AtlasAuth {
  initialize(): Promise<void>;
  onAuthStateChanged(cb: (state: AuthState) => void): () => void;
  readonly currentAuthState: AuthState;
  signIn(email: string, password: string): Promise<void>;
  register(email: string, password: string, name?: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  signOut(): void;
}

const SIGNED_OUT: AuthState = { authenticated: false, authProviderId: null, profileId: null };
const STORAGE_KEY = 'atlas-stub-session';
const DEMO_EMAIL = 'dennis@atlas.dev';

interface StubSession {
  id: string;
  email: string;
  name: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Flip-ready stub. Mirrors the real `Auth` lifecycle precisely: `onAuthStateChanged` does NOT fire
 * until `initialize()` resolves (matches the guard pattern of subscribe-then-initialize). Accepts the
 * demo credentials from the handoff (`dennis@atlas.dev` + any ≥8-char password); a wrong pair throws
 * so the auth screens can show the error banner.
 */
class StubAuth implements AtlasAuth {
  private state: AuthState = SIGNED_OUT;
  private initializing = true;
  private readonly listeners = new Set<(s: AuthState) => void>();

  get currentAuthState(): AuthState {
    return { ...this.state };
  }

  async initialize(): Promise<void> {
    try {
      const session = this.read();
      this.state = session ? this.toState(session) : SIGNED_OUT;
    } finally {
      this.initializing = false;
      this.notify();
    }
  }

  onAuthStateChanged(cb: (state: AuthState) => void): () => void {
    this.listeners.add(cb);
    if (!this.initializing) cb(this.currentAuthState);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async signIn(email: string, password: string): Promise<void> {
    await delay(450);
    if (email.trim().toLowerCase() !== DEMO_EMAIL || password.length < 8) {
      throw new Error('Invalid email or password.');
    }
    this.persist({ id: 'U-OPERATOR', email: DEMO_EMAIL, name: 'Dennis Lysenko' });
  }

  async register(email: string, password: string, name?: string): Promise<void> {
    await delay(450);
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');
    this.persist({ id: 'U-OPERATOR', email: email.trim(), name: name?.trim() || email.trim() });
  }

  async signInWithGoogle(): Promise<void> {
    await delay(700);
    this.persist({ id: 'U-OPERATOR', email: DEMO_EMAIL, name: 'Dennis Lysenko' });
  }

  async requestPasswordReset(_email: string): Promise<void> {
    await delay(550);
    // No-op in the stub — there is no backend reset route yet (flagged in BACKEND_GAPS.md).
  }

  signOut(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    this.state = SIGNED_OUT;
    this.notify();
  }

  private persist(session: StubSession): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      /* ignore */
    }
    this.state = this.toState(session);
    this.notify();
  }

  private read(): StubSession | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as StubSession) : null;
    } catch {
      return null;
    }
  }

  private toState(session: StubSession): AuthState {
    return { authenticated: true, authProviderId: session.id, profileId: session.id };
  }

  private notify(): void {
    const snapshot = this.currentAuthState;
    this.listeners.forEach((l) => l(snapshot));
  }
}

/**
 * Pull the human message out of an Axios-style error. The `@workspace/auth` client rethrows the raw
 * Axios error on a 4xx, whose `.response.data.message` carries our Nest exception message (e.g. the
 * pending-approval text on register, or "Invalid email or password." on login). class-validator
 * failures arrive as a `string[]`; join them. Falls back to the generic message when absent.
 */
function authErrorMessage(err: unknown, fallback: string): Error {
  const data = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data;
  const message = data?.message;
  if (Array.isArray(message)) return new Error(message.join('; '));
  if (typeof message === 'string' && message) return new Error(message);
  return new Error(err instanceof Error && err.message ? err.message : fallback);
}

/** Real adapter — wraps `@workspace/auth` against the Atlas app's `/auth/*` (direct, credentialed CORS). */
class RealAuth implements AtlasAuth {
  private readonly inner = new Auth<{ id: string }>();

  constructor() {
    this.inner.configure({
      // Absolute base → the Atlas HTTP app directly (cookie session rides on credentialed CORS).
      apiBaseUrl: env.NEXT_PUBLIC_ATLAS_HTTP_URL,
      authBasePath: '/auth',
      sessionToAuthState: (s) => ({ authenticated: true, authProviderId: s.id, profileId: s.id }),
    });
  }

  get currentAuthState(): AuthState {
    return this.inner.currentAuthState;
  }
  initialize(): Promise<void> {
    return this.inner.initialize();
  }
  onAuthStateChanged(cb: (state: AuthState) => void): () => void {
    return this.inner.onAuthStateChanged(cb);
  }
  async signIn(email: string, password: string): Promise<void> {
    try {
      await this.inner.signIn(email, password);
    } catch (err) {
      throw authErrorMessage(err, 'Sign in failed.');
    }
  }
  async register(email: string, password: string): Promise<void> {
    try {
      await this.inner.register(email, password);
    } catch (err) {
      // New accounts are created blocked → the backend returns 403 with the pending-approval message,
      // which surfaces in the signup banner here.
      throw authErrorMessage(err, 'Could not create your account.');
    }
  }
  async signInWithGoogle(): Promise<void> {
    throw new Error('Google sign-in is not configured on the backend yet.');
  }
  async requestPasswordReset(): Promise<void> {
    throw new Error('Password reset is not configured on the backend yet.');
  }
  signOut(): void {
    this.inner.signOut();
  }
}

export const auth: AtlasAuth =
  env.NEXT_PUBLIC_AUTH_MODE === EAuthMode.REAL ? new RealAuth() : new StubAuth();
