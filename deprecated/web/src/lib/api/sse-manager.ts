'use client';

import { connectivity } from './connectivity';
import { refreshSession } from './refresh';

/**
 * Shared, ref-counted EventSource registry — ONE browser connection per URL, no matter how many hooks
 * subscribe to it.
 *
 * Why this exists: in dev the console talks to the backend over plain HTTP (`http://…:4002`), i.e. HTTP/1.1,
 * where the browser caps ~6 connections per host (shared across ALL tabs of the origin). Every long-lived
 * SSE stream permanently holds one of those slots, so opening the same `/repos/:repoId/events` stream from
 * several hooks — or, worse, re-opening it on every thread switch — could saturate the pool and wedge every
 * REST fetch in a perpetual "Loading…". Centralizing the stream lifecycle here guarantees:
 *   (a) the same URL is never opened twice (dedup across hooks),
 *   (b) thread switches reuse the standing connection instead of tearing it down + reopening, and
 *   (c) the connect / 401-refresh / reconnect resilience lives in exactly ONE place (it used to be
 *       copy-pasted across three hooks).
 *
 * NOTE: this dedups by URL — it does NOT merge *different* endpoints. A workspace tab still holds the
 * cross-org realtime stream AND the open repo's event stream (two distinct URLs = two connections).
 * Collapsing those into one requires a backend change to fold the feeds; this layer removes the churn and
 * the duplicate-URL connections, which is the part that bit on every thread switch.
 */

export interface SseHandle {
  /** Stop this URL's stream for good (no reconnect) until every subscriber has detached. */
  closePermanently(): void;
}

export interface SseSubscriber {
  /** A raw SSE message payload (`MessageEvent.data`). */
  onFrame(data: string, handle: SseHandle): void;
  /**
   * Fired when the underlying connection (re)opens — and immediately on subscribe if it is ALREADY open, so
   * a late joiner still gets its catch-up (e.g. an invalidate-on-connect) without waiting for a reconnect.
   *
   * `kind` distinguishes the two: `'connect'` is a REAL (re)connection — the server replays its
   * catch-up state (e.g. live-turn snapshots) right after this; `'late-join'` is a subscriber attaching
   * to an already-open stream — nothing is replayed, so reconnect-only reconciliation (like sweeping
   * live turns the snapshots didn't re-confirm) must not run on it.
   */
  onOpen?(handle: SseHandle, kind: 'connect' | 'late-join'): void;
}

/**
 * ms an idle (zero-subscriber) connection lingers before it is actually closed. Absorbs React StrictMode's
 * dev mount→unmount→remount and quick back-to-back navigation so we don't needlessly drop + reopen the
 * socket (which would reintroduce exactly the churn this module exists to remove).
 *
 * Exported so other module-level caches that sit ON TOP of a shared connection (e.g. `service-log-store`)
 * can match this same grace window — otherwise a cache could evict its content sooner than the connection
 * itself lingers, defeating the point of both.
 */
export const IDLE_LINGER_MS = 2_000;

/**
 * Reconnect backoff after a FATAL EventSource close. Fatal closes are what a backend restart produces:
 * the watch respawn kills the socket, EventSource's own retry hits ERR_CONNECTION_REFUSED while the port
 * is unbound, and that failed ATTEMPT closes the stream for good (readyState CLOSED — the browser never
 * retries it). So WE own the retry loop, forever, until the stream opens or the last subscriber leaves.
 * Capped low enough that a dev restart (a few seconds) heals within one or two ticks; the connectivity
 * store's recovery probe also kicks a waiting retry the moment the backend answers again.
 */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

class SharedConnection implements SseHandle {
  private es: EventSource | null = null;
  private readonly subs = new Set<SseSubscriber>();
  /** Set by `closePermanently()` (e.g. the server signalled realtime is disabled) — never reconnect while held. */
  private sealed = false;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed (re)connect cycles — indexes the backoff; reset on a successful open. */
  private retryAttempt = 0;

  constructor(
    private readonly url: string,
    private readonly onEmpty: () => void,
  ) {}

  add(sub: SseSubscriber): () => void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.subs.add(sub);
    if (this.retryTimer)
      this.kick(); // mid-backoff — a fresh subscriber wants the stream NOW
    else if (!this.es && !this.sealed) this.connect();
    else if (this.es?.readyState === EventSource.OPEN) sub.onOpen?.(this, 'late-join'); // already open → catch-up now
    return () => this.remove(sub);
  }

  private remove(sub: SseSubscriber): void {
    this.subs.delete(sub);
    if (this.subs.size > 0 || this.lingerTimer) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.subs.size > 0) return; // re-subscribed during the linger window → keep the connection
      this.clearRetry();
      this.es?.close();
      this.es = null;
      this.onEmpty();
    }, IDLE_LINGER_MS);
  }

  closePermanently(): void {
    this.sealed = true;
    this.clearRetry();
    this.es?.close();
    this.es = null;
  }

  /** Retry NOW if we're sitting out a backoff (the backend just answered a connectivity probe). */
  kick(): void {
    if (this.sealed || !this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.reconnectCycle();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAttempt = 0;
  }

  private connect(): void {
    if (this.sealed || this.es) return;
    const es = new EventSource(this.url, { withCredentials: true });
    this.es = es;
    es.onopen = () => {
      this.retryAttempt = 0;
      connectivity.reportReachable();
      this.subs.forEach((s) => s.onOpen?.(this, 'connect'));
    };
    es.onmessage = (e: MessageEvent) => {
      connectivity.reportReachable();
      const data = e.data as string;
      this.subs.forEach((s) => s.onFrame(data, this));
    };
    es.onerror = () => {
      connectivity.reportUnreachable();
      // Let EventSource self-heal transient drops (readyState CONNECTING). Only act on a FATAL close —
      // an HTTP error (e.g. 401 after the access cookie expired) or a refused connection (backend
      // restart gap). The `this.es !== es` guard ignores a stale closure after we've already moved on.
      if (this.es !== es || es.readyState !== EventSource.CLOSED || this.sealed) return;
      this.es = null;
      es.close();
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.sealed || this.retryTimer || this.subs.size === 0) return;
    const delay =
      RECONNECT_BACKOFF_MS[Math.min(this.retryAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.reconnectCycle();
    }, delay);
  }

  /**
   * One retry cycle: refresh the session, then reconnect. EventSource exposes no status code, so we
   * can't tell a 401 close from a restart-gap refused connection — the refresh handles the former (it's
   * a cheap re-issue when the cookie is still valid) and is a harmless transient failure during the
   * latter. Crucially we reconnect EVEN IF the refresh failed: while the backend is down the refresh
   * fails network-level (`false`), and gating the reconnect on it is exactly what used to seal a page
   * forever after a watch respawn.
   */
  private reconnectCycle(): void {
    void refreshSession().finally(() => {
      if (!this.sealed && !this.es && this.subs.size > 0) this.connect();
    });
  }
}

const registry = new Map<string, SharedConnection>();

/**
 * The connectivity store's recovery probe answers before our next backoff tick fires (its own backoff is
 * tighter) — the moment it flips back to `online`, retry every stream that's sitting out a backoff so an
 * open page heals as one batch instead of trickling in over up-to-15s.
 */
let connectivityKickInstalled = false;
function installConnectivityKick(): void {
  if (connectivityKickInstalled) return;
  connectivityKickInstalled = true;
  connectivity.subscribe(() => {
    if (connectivity.getSnapshot() === 'online') registry.forEach((c) => c.kick());
  });
}

/**
 * Subscribe to the shared EventSource for `url`. Returns an unsubscribe fn. The connection opens on the
 * first subscriber and closes shortly after the last one detaches (see `IDLE_LINGER_MS`).
 */
export function subscribeSse(_url: string, _sub: SseSubscriber): () => void {
  // TODO(rtk): the realtime SSE endpoints (/web/.../events, /realtime) aren't wired on the new backend
  // yet — no-op so no EventSource connections are opened (avoids 404 reconnect loops). The connection-
  // pooling implementation (SharedConnection + registry, above) is retained for when they exist; restore
  // this body from git history to re-enable it.
  return () => {};
}
