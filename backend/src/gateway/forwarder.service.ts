import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { TenantStore } from './tenants/tenant.store';

/** Events: fire-and-forget with a short retry ladder. */
const EVENT_RETRY_DELAYS_MS = [0, 250, 1_000];
/** Interactivity: the stack's reply IS Slack's response body — bounded so the 3s budget holds. */
const INTERACTIVITY_TIMEOUT_MS = 2_500;

export interface ForwardedInteractivityResponse {
  status: number;
  body: unknown;
}

/**
 * Routes verified Slack traffic to the owning tenant stack's `/slack/inbound` (shared-secret
 * bearer, internal network). Events are best-effort — the gateway has already 200'd Slack, and
 * dropped-while-down matches the surface's existing no-backfill stance. Interactivity is relayed
 * SYNCHRONOUSLY so a modal's `response_action: errors` round-trips to the user.
 */
@Injectable()
export class ForwarderService {
  private readonly logger = new Logger(ForwarderService.name);

  constructor(
    private readonly tenants: TenantStore,
    private readonly env: EnvService,
  ) {}

  async forwardEvent(teamId: string, body: unknown): Promise<void> {
    const target = await this.targetFor(teamId);
    if (!target) return;
    for (const delay of EVENT_RETRY_DELAYS_MS) {
      if (delay) await sleep(delay);
      try {
        const res = await this.post(target, { kind: 'event', teamId, body });
        if (res.ok) return;
        if (res.status < 500) {
          this.logger.warn(`stack ${teamId} rejected event (${res.status}) — dropping`);
          return; // 4xx is a contract problem, not a transient — retrying won't help
        }
      } catch {
        // network error — fall through to the next retry
      }
    }
    this.logger.warn(`event for ${teamId} dropped after ${EVENT_RETRY_DELAYS_MS.length} attempts`);
  }

  async forwardInteractivity(
    teamId: string,
    payload: unknown,
  ): Promise<ForwardedInteractivityResponse> {
    const target = await this.targetFor(teamId);
    if (!target) return { status: 200, body: {} };
    try {
      const res = await this.post(
        target,
        { kind: 'interactivity', teamId, payload },
        INTERACTIVITY_TIMEOUT_MS,
      );
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : {} };
    } catch (err) {
      this.logger.warn(`interactivity relay to ${teamId} failed: ${err}`);
      return { status: 200, body: {} }; // empty 200 — Slack closes the modal rather than erroring
    }
  }

  private async targetFor(teamId: string): Promise<string | undefined> {
    const tenant = await this.tenants.get(teamId);
    if (!tenant) {
      this.logger.warn(`event for unknown team ${teamId} — dropping (not installed?)`);
      return undefined;
    }
    if (tenant.status !== 'active' || !tenant.stackBaseUrl) {
      this.logger.warn(`tenant ${teamId} is ${tenant.status}/unprovisioned — dropping`);
      return undefined;
    }
    return `${tenant.stackBaseUrl.replace(/\/+$/, '')}/slack/inbound`;
  }

  private post(url: string, payload: unknown, timeoutMs = 5_000): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.env.get('GATEWAY_SHARED_SECRET')}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
