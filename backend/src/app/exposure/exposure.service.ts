import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
  type ServiceLivenessProbe,
} from '../sandbox/sandbox-provider.port';
import { CaddyAdminClient } from './caddy-admin.client';
import { hostFor, routeId, routePrefix, urlFor } from './exposure-naming';
import { readServiceMarkers, serviceStatus } from './service-markers';

/**
 * Drives Caddy to publish a thread sandbox's live, opted-in dev-servers at deterministic preview URLs.
 * Feature-gated on `PREVIEW_BASE_DOMAIN`: with it unset the whole service is inert (dev/local is
 * unchanged). Reconciliation is fully idempotent + best-effort — it reads the durable `atlas-svc`
 * markers, probes which are actually running, then converges Caddy's routes (+ the Caddy↔sandbox network
 * bridge) to exactly the desired set, so a missed webhook / restart self-heals on the next pass.
 */
@Injectable()
export class ExposureService {
  private readonly logger = new Logger(ExposureService.name);

  constructor(
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    private readonly caddy: CaddyAdminClient,
    private readonly env: EnvService,
  ) {}

  private secret(): string {
    return this.env.get('PREVIEW_ID_SECRET') ?? this.env.get('SECRETS_ENCRYPTION_KEY');
  }

  private baseDomain(): string | undefined {
    return this.env.get('PREVIEW_BASE_DOMAIN');
  }

  /** True when preview exposure is configured (a base domain is set). */
  get enabled(): boolean {
    return !!this.baseDomain();
  }

  /** The public preview URL for a named service, or null when exposure is disabled. */
  urlFor(jobId: string, name: string): string | null {
    const base = this.baseDomain();
    return base ? urlFor(jobId, name, this.secret(), base) : null;
  }

  /** The public preview host for a named service, or null when exposure is disabled. */
  hostFor(jobId: string, name: string): string | null {
    const base = this.baseDomain();
    return base ? hostFor(jobId, name, this.secret(), base) : null;
  }

  /**
   * Converge Caddy's routes for one job to exactly its live, opted-in, port-bearing services. Reads the
   * durable markers, probes liveness (generation-gated), then: if any service is desired, bridges Caddy
   * into the sandbox network once and upserts each route (deleting stale ones); if none, deletes the
   * job's whole route set and unbridges. Best-effort throughout — one Caddy/docker failure is logged and
   * skipped rather than aborting the loop. No-op when exposure is disabled.
   */
  async reconcile(jobId: string): Promise<void> {
    if (!this.enabled) return;
    const dir = this.provider.supervisorDirHost(jobId);
    const markers = dir ? readServiceMarkers(dir) : [];
    const exposable = markers.filter((m) => m.port != null && m.expose);

    const pgids = exposable.map((m) => m.pgid).filter((p): p is number => p != null);
    const probe = await this.provider.probeLiveness(jobId, pgids).catch(
      () => ({ status: 'unknown' }) as ServiceLivenessProbe,
    );

    // A transient probe failure resolves to `unknown`; it must NOT be read as "nothing running" — doing so
    // would delete routes + unbridge Caddy for dev-servers that are still up, flapping the preview URL
    // (brief 502s) on every exec hiccup (the `ServiceLivenessProbe` contract). Only converge toward the
    // teardown branch on a DEFINITE state: no exposable markers at all, or a probe that actually resolved
    // (`up`/`down`). On `unknown` with markers present, leave the existing routes + bridge untouched.
    if (exposable.length > 0 && probe.status === 'unknown') return;

    const desired = exposable.filter((m) => serviceStatus(m, probe) === 'running');

    const secret = this.secret();
    const prefix = routePrefix(jobId, secret);

    if (desired.length === 0) {
      await this.caddy
        .deleteRoutesByPrefix(prefix)
        .catch((err) => this.logger.debug(`deleteRoutesByPrefix(${prefix}) failed: ${err}`));
      await this.provider
        .unbridgeCaddyFromSandbox(jobId)
        .catch((err) => this.logger.debug(`unbridge(${jobId}) failed: ${err}`));
      return;
    }

    await this.provider
      .bridgeCaddyToSandbox(jobId)
      .catch((err) => this.logger.warn(`bridgeCaddyToSandbox(${jobId}) failed: ${err}`));

    const upstreamHost = this.provider.sandboxContainerName(jobId);
    const desiredRouteIds = new Set<string>();
    for (const m of desired) {
      const id = routeId(jobId, m.name, secret);
      desiredRouteIds.add(id);
      await this.caddy
        .upsertRoute({
          id,
          host: hostFor(jobId, m.name, secret, this.baseDomain()!),
          upstream: `${upstreamHost}:${m.port}`,
        })
        .catch((err) => this.logger.warn(`upsertRoute(${id}) failed: ${err}`));
    }

    // Reconcile deletions: drop any of THIS job's routes that no longer map to a live desired service.
    try {
      const stale = (await this.caddy.listRouteIds()).filter(
        (id) => id.startsWith(prefix) && !desiredRouteIds.has(id),
      );
      for (const id of stale) {
        await this.caddy
          .deleteRoute(id)
          .catch((err) => this.logger.debug(`deleteRoute(${id}) failed: ${err}`));
      }
    } catch (err) {
      this.logger.debug(`stale-route reconcile for ${jobId} failed: ${err}`);
    }
  }

  /** Reconcile every live managed thread sandbox — the periodic self-heal driven by the reap timer. */
  async reconcileAll(): Promise<void> {
    if (!this.enabled) return;
    const jobIds = await this.provider.listLiveThreadJobIds().catch(() => [] as string[]);
    for (const j of jobIds) {
      await this.reconcile(j).catch(() => undefined);
    }
  }
}
