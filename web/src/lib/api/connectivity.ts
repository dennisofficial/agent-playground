'use client';

import { auth } from '@/lib/auth';
import { env } from '@/lib/env';
import { useSyncExternalStore } from 'react';

/**
 * Global backend-connectivity signal — orthogonal to auth (a `/web/*` outage is not an auth state).
 *
 * `@dltech/jwt-auth` only flips `AuthState.backendUnreachable` when an *auth* call fails, so a backend
 * that dies while the operator sits in the workspace would otherwise show nothing until the next auth
 * round-trip. This vanilla singleton lets the non-React in-app paths — `fetchWithRefresh` (`./refresh`)
 * and the `/web/events` EventSource (`./events`) — report liveness, and surfaces it to React via
 * `useSyncExternalStore`. <ConnectivityGate> renders the lightweight banner (transient) or the
 * persistent red <OfflineIndicator> pill (sustained) — never taking over the screen; recovery is
 * store-owned (see `probe`).
 *
 * Three-state machine, time-debounced so a one-off blip never flickers the UI:
 *   online ──(failure persists ≥ RECONNECTING_AFTER_MS)──▶ reconnecting ──(≥ OFFLINE_AFTER_MS)──▶ offline
 *   └──────────────────────── any reachable signal / successful probe ────────────────────────────┘
 */
export type ConnectivityStatus = 'online' | 'reconnecting' | 'offline';

const RECONNECTING_AFTER_MS = 1500;
const OFFLINE_AFTER_MS = 8000;
const PROBE_BACKOFF_MS = [600, 1500, 3000, 5000, 8000];

type Timer = ReturnType<typeof setTimeout>;

class ConnectivityStore {
  private status: ConnectivityStatus = 'online';
  /** Wall-clock of the first failure in the current degraded streak; `null` while healthy. */
  private degradedSince: number | null = null;
  private bannerTimer: Timer | null = null;
  private offlineTimer: Timer | null = null;
  private probeTimer: Timer | null = null;
  private probeAttempt = 0;
  private readonly listeners = new Set<() => void>();

  constructor() {
    if (typeof window !== 'undefined') {
      // Network restored / tab refocused → recheck immediately instead of waiting out the backoff.
      window.addEventListener('online', this.kickProbe);
      window.addEventListener('focus', this.kickProbe);
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  /** Any HTTP *response* proves the backend answered — even a 401/500. Clears a degraded streak. */
  reportReachable(): void {
    if (this.degradedSince === null && this.status === 'online') return; // hot-path no-op (healthy)
    this.clearTimers();
    this.degradedSince = null;
    this.probeAttempt = 0;
    this.setStatus('online');
  }

  /**
   * A network-level failure (fetch rejection / EventSource error — the server didn't answer). Arms
   * escalation on the first edge only; repeated failures while already degraded are no-ops so the
   * timers run to real wall-clock thresholds instead of being reset on every retry.
   */
  reportUnreachable(): void {
    if (this.degradedSince !== null) return; // already degraded — timers + probe already running
    this.degradedSince = Date.now();
    this.bannerTimer = setTimeout(() => {
      if (this.degradedSince !== null) this.setStatus('reconnecting');
    }, RECONNECTING_AFTER_MS);
    this.offlineTimer = setTimeout(() => {
      if (this.degradedSince !== null) this.setStatus('offline');
    }, OFFLINE_AFTER_MS);
    this.scheduleProbe();
  }

  // Arrow props keep `this` bound when destructured by useSyncExternalStore.
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): ConnectivityStatus => this.status;
  getServerSnapshot = (): ConnectivityStatus => 'online';

  private setStatus(next: ConnectivityStatus): void {
    if (next === this.status) return;
    this.status = next;
    this.listeners.forEach((l) => l());
  }

  private clearTimers(): void {
    for (const t of [this.bannerTimer, this.offlineTimer, this.probeTimer]) if (t) clearTimeout(t);
    this.bannerTimer = this.offlineTimer = this.probeTimer = null;
  }

  private scheduleProbe(): void {
    const delay = PROBE_BACKOFF_MS[Math.min(this.probeAttempt, PROBE_BACKOFF_MS.length - 1)];
    this.probeTimer = setTimeout(() => void this.probe(), delay);
  }

  /** Browser told us the network is back (or the tab refocused) — probe now, skipping the backoff. */
  private kickProbe = (): void => {
    if (this.degradedSince === null) return; // only meaningful while degraded
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeAttempt = 0;
    this.probeTimer = setTimeout(() => void this.probe(), 0);
  };

  private onVisibility = (): void => {
    if (typeof document !== 'undefined' && !document.hidden) this.kickProbe();
  };

  /**
   * Lightweight liveness check while degraded. ANY response (even 401/500) means the backend is up, so
   * we treat it as reachable; only a network reject keeps us down (and backs off). On recovery we also
   * fire `auth.recheck()` so a parallel auth-driven `backendUnreachable` (PrivateGuard) clears too.
   */
  private async probe(): Promise<void> {
    if (this.degradedSince === null) return; // recovered out from under this scheduled tick
    try {
      await fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/web/ping`, {
        credentials: 'include',
        cache: 'no-store',
      });
      void auth.recheck();
      this.reportReachable();
    } catch {
      this.probeAttempt += 1;
      this.scheduleProbe();
    }
  }
}

export const connectivity = new ConnectivityStore();

export function useConnectivity(): ConnectivityStatus {
  return useSyncExternalStore(
    connectivity.subscribe,
    connectivity.getSnapshot,
    connectivity.getServerSnapshot,
  );
}
