"use client";

import { Auth, type AuthState } from "@workspace/auth";
import { env } from "./env";

export type { AuthState };

/**
 * The auth surface the Atlas console consumes — a thin superset of the real `@workspace/auth`
 * (`signIn` / `register` / `signOut` / `initialize` / `recheck` / `onAuthStateChanged` /
 * `currentAuthState`) plus the two design flows the backend doesn't expose yet (`signInWithGoogle`,
 * `requestPasswordReset`). Implemented by `RealAuth`, wrapping `new Auth(...)` against the Atlas app's
 * `/auth/*` (direct, credentialed CORS).
 */
export interface AtlasAuth {
  initialize(): Promise<void>;
  /**
   * Re-probe the backend after a `backendUnreachable` outage (the "Retry" action on the server
   * unreachable screen). On success the auth state flips and `onAuthStateChanged` subscribers
   * re-render automatically; on continued failure the state stays unreachable.
   */
  recheck(): Promise<void>;
  onAuthStateChanged(cb: (state: AuthState) => void): () => void;
  readonly currentAuthState: AuthState;
  signIn(email: string, password: string): Promise<void>;
  register(email: string, password: string, name?: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  signOut(): void;
}

/**
 * Pull the human message out of an Axios-style error. The `@workspace/auth` client rethrows the raw
 * Axios error on a 4xx, whose `.response.data.message` carries our Nest exception message (e.g. the
 * pending-approval text on register, or "Invalid email or password." on login). class-validator
 * failures arrive as a `string[]`; join them. Falls back to the generic message when absent.
 */
function authErrorMessage(err: unknown, fallback: string): Error {
  const data = (
    err as { response?: { data?: { message?: string | string[] } } }
  )?.response?.data;
  const message = data?.message;
  if (Array.isArray(message)) return new Error(message.join("; "));
  if (typeof message === "string" && message) return new Error(message);
  return new Error(
    err instanceof Error && err.message ? err.message : fallback,
  );
}

/** Real adapter — wraps `@workspace/auth` against the Atlas app's `/auth/*` (direct, credentialed CORS). */
class RealAuth implements AtlasAuth {
  private readonly inner = new Auth<{ id: string }>();

  constructor() {
    this.inner.configure({
      // Absolute base → the Atlas HTTP app directly (cookie session rides on credentialed CORS).
      apiBaseUrl: env.NEXT_PUBLIC_HTTP_URL,
      authBasePath: "/auth",
      sessionToAuthState: (s) => ({
        authenticated: true,
        authProviderId: s.id,
        profileId: s.id,
      }),
    });
  }

  get currentAuthState(): AuthState {
    return this.inner.currentAuthState;
  }
  initialize(): Promise<void> {
    return this.inner.initialize();
  }
  recheck(): Promise<void> {
    // Re-hit /auth/session; on success `checkSession` clears `backendUnreachable` and notifies guards.
    return this.inner.checkSession();
  }
  onAuthStateChanged(cb: (state: AuthState) => void): () => void {
    return this.inner.onAuthStateChanged(cb);
  }
  async signIn(email: string, password: string): Promise<void> {
    try {
      await this.inner.signIn(email, password);
    } catch (err) {
      throw authErrorMessage(err, "Sign in failed.");
    }
  }
  async register(email: string, password: string): Promise<void> {
    try {
      await this.inner.register(email, password);
    } catch (err) {
      // New accounts are created blocked → the backend returns 403 with the pending-approval message,
      // which surfaces in the signup banner here.
      throw authErrorMessage(err, "Could not create your account.");
    }
  }
  async signInWithGoogle(): Promise<void> {
    throw new Error("Google sign-in is not configured on the backend yet.");
  }
  async requestPasswordReset(): Promise<void> {
    throw new Error("Password reset is not configured on the backend yet.");
  }
  signOut(): void {
    this.inner.signOut();
  }
}

export const auth: AtlasAuth = new RealAuth();
