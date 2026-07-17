import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
  type ServiceLivenessProbe,
} from '../sandbox/sandbox-provider.port';
import { CaddyAdminClient } from './caddy-admin.client';
import { hostFor, routeId, routePrefix, urlFor } from './exposure-naming';
import { derivePortState, readServiceMarkers, serviceStatus } from './service-markers';

@Injectable()
export class ExposureService {
  private readonly logger = new Logger(ExposureService.name);

  constructor(
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    private readonly caddy: CaddyAdminClient,
    private readonly env: EnvService,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
  ) {}

  private secret(): string {
    return this.env.get('PREVIEW_ID_SECRET') ?? this.env.get('SECRETS_ENCRYPTION_KEY');
  }

  private baseDomain(): string | undefined {
    return this.env.get('PREVIEW_BASE_DOMAIN');
  }

  get enabled(): boolean {
    return !!this.baseDomain();
  }

  urlFor(jobId: string, name: string): string | null {
    const base = this.baseDomain();
    return base ? urlFor(jobId, name, this.secret(), base) : null;
  }

  hostFor(jobId: string, name: string): string | null {
    const base = this.baseDomain();
    return base ? hostFor(jobId, name, this.secret(), base) : null;
  }

  async reconcile(jobId: string): Promise<void> {
    const dir = this.provider.supervisorDirHost(jobId);
    const markers = dir ? readServiceMarkers(dir) : [];
    const allPgids = markers.map((m) => m.pgid).filter((p): p is number => p != null);
    const probe = await this.provider
      .probeLiveness(jobId, allPgids)
      .catch(() => ({ status: 'unknown' }) as ServiceLivenessProbe);

    if (!(markers.length > 0 && probe.status === 'unknown')) {
      const portState = derivePortState(markers, probe, (m) => this.urlFor(jobId, m.name) != null);
      await this.jobs
        .createQueryBuilder()
        .update()
        .set({ port_state: portState })
        .where('id = :id AND port_state IS DISTINCT FROM :ps', {
          id: jobId,
          ps: portState,
        })
        .execute()
        .catch((err) => this.logger.debug(`persist port_state(${jobId}) failed: ${err}`));
    }

    if (!this.enabled) return;

    const exposable = markers.filter((m) => m.port != null && m.expose);

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

  async reconcileAll(): Promise<void> {
    let jobIds: string[];
    try {
      jobIds = await this.provider.listLiveThreadJobIds();
    } catch {
      return; // transient — skip this tick entirely rather than sweep against an empty set
    }
    for (const j of jobIds) await this.reconcile(j).catch(() => undefined);
    const qb = this.jobs
      .createQueryBuilder()
      .update()
      .set({ port_state: null })
      .where('port_state IS NOT NULL');
    if (jobIds.length > 0) qb.andWhere('id NOT IN (:...live)', { live: jobIds });
    await qb
      .execute()
      .catch((err) => this.logger.debug(`port_state teardown sweep failed: ${err}`));
  }
}
