import { EnvService } from '@core/config/env/env.service';
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeaderElectionService } from '../cluster';
import { LocalGitService } from '../git/local-git.service';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { WorkspaceSkillEntity } from '../persistence/entities';
import { SkillInstallerService } from './skill-installer.service';

/** How often the leader re-checks every `git`-provenance skill against its remote. Skills move rarely
 *  (unlike PR/CI state) — an infrequent cadence is deliberate; job-start reconciliation (below) covers the
 *  "I just changed a source and want it now" case without waiting on the interval. */
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
/** SchedulerRegistry interval name (process-unique) for the leader-gated reconcile sweep. */
const SKILL_UPDATER_INTERVAL = 'skills:skill-updater';

/**
 * LEADER-ONLY reconciler for `provenance:'git'` skills (custom/forked rows are never touched — they have
 * no `source_url`). Runs on a cadence AND fire-and-forget on job creation (`reconcileOrgAsync`, called from
 * `JobLifecycleService.createJob`) — the two triggers the plan calls for. Own leader-gated timer (the
 * `TurnStreamReaperService` pattern: `@Global` skills module has no reason to route through the driver's
 * reap timer for an unrelated domain).
 *
 * `track-ref` skills auto-update (re-vendor + bump `installed_sha`); `pinned`/`manual` skills only flip
 * `update_available` for the console badge — actually applying is a one-click `applyNow` off the SAME row
 * (see `SkillsController`'s update endpoint).
 *
 * MARKETPLACE SCOPE NOTE: each marketplace-derived row stores `source_subpath` pointing at ITS OWN skill
 * dir (not the manifest), so per-row reconcile re-vendors that one skill's CONTENT correctly, but it can't
 * detect skills a manifest update ADDED or REMOVED (there's no "these N rows share one manifest install"
 * link in the schema) — a full re-expand only happens when `SkillInstallerService.install` is re-run
 * against the marketplace's own source/subpath (the install endpoint). Flagged as a known gap, not silently
 * assumed — see the P2 handoff summary.
 */
@Injectable()
export class SkillUpdaterService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SkillUpdaterService.name);
  private promoteSub?: { unsubscribe(): void };
  private demoteSub?: { unsubscribe(): void };

  constructor(
    @InjectRepository(WorkspaceSkillEntity, DB_CONNECTION)
    private readonly skills: Repository<WorkspaceSkillEntity>,
    private readonly installer: SkillInstallerService,
    private readonly git: LocalGitService,
    private readonly creds: CredentialResolver,
    private readonly election: LeaderElectionService,
    private readonly env: EnvService,
    // Prod always injects the scheduler (global ScheduleModule); unit tests omit it and never promote, so
    // the reconciler never starts there.
    @Optional() private readonly scheduler?: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.get('POSTGRES_DB')?.endsWith('_test')) {
      this.logger.log('skill updater off (test database)');
      return;
    }
    this.promoteSub = this.election.onPromote(() => this.start());
    this.demoteSub = this.election.onDemote(() => this.stop());
  }

  onApplicationShutdown(): void {
    this.promoteSub?.unsubscribe();
    this.demoteSub?.unsubscribe();
    this.stop();
  }

  private start(): void {
    if (!this.scheduler) return;
    if (this.scheduler.doesExist('interval', SKILL_UPDATER_INTERVAL)) return;
    void this.reconcileAll(); // boot/promotion sweep
    const iv = setInterval(() => void this.reconcileAll(), RECONCILE_INTERVAL_MS);
    iv.unref?.(); // never keep the process alive (SchedulerRegistry does not unref for us)
    this.scheduler.addInterval(SKILL_UPDATER_INTERVAL, iv);
    this.logger.log('skill updater started (leader)');
  }

  private stop(): void {
    // deleteInterval clears the interval AND removes it from the registry.
    if (this.scheduler?.doesExist('interval', SKILL_UPDATER_INTERVAL)) {
      this.scheduler.deleteInterval(SKILL_UPDATER_INTERVAL);
    }
  }

  /** Check + (maybe) apply updates for every `git` skill across every org. Fail-soft per row. */
  async reconcileAll(): Promise<void> {
    const rows = await this.skills.find({ where: { provenance: 'git' } });
    for (const row of rows) {
      await this.reconcileOne(row).catch((err) =>
        this.logger.warn(`update-check failed org=${row.org_id} scope=${row.scope} name=${row.name}: ${err}`),
      );
    }
  }

  /**
   * Fire-and-forget re-check of one org's git skills — the "on job start" trigger the plan asks for, wired
   * from `JobLifecycleService.createJob`. Never awaited by the caller (job creation must not block on a
   * network round trip per skill); errors are logged, not thrown.
   */
  reconcileOrgAsync(orgId: string): void {
    void this.skills
      .find({ where: { org_id: orgId, provenance: 'git' } })
      .then((rows) =>
        Promise.all(
          rows.map((row) =>
            this.reconcileOne(row).catch((err) =>
              this.logger.warn(`update-check failed org=${row.org_id} scope=${row.scope} name=${row.name}: ${err}`),
            ),
          ),
        ),
      )
      .catch((err) => this.logger.warn(`update-check failed org=${orgId}: ${err}`));
  }

  /** Apply-now for one row, regardless of `update_policy` — the console's "update" button / API endpoint. */
  async applyNow(orgId: string, scope: string, name: string): Promise<void> {
    const row = await this.skills.findOne({ where: { org_id: orgId, scope, name } });
    if (!row) throw new BadRequestException(`unknown skill '${name}'`);
    if (row.provenance !== 'git' || !row.source_url) {
      throw new BadRequestException(`'${name}' has no git source to update from (provenance=${row.provenance})`);
    }
    await this.installer.install({
      orgId: row.org_id,
      scope: row.scope,
      sourceUrl: row.source_url,
      ref: row.source_ref ?? undefined,
      subpath: row.source_subpath ?? undefined,
      updatePolicy: row.update_policy ?? undefined,
      surfaces: row.surfaces,
    });
    if (row.update_available) {
      await this.skills.update({ org_id: row.org_id, scope: row.scope, name: row.name }, { update_available: false });
    }
  }

  private async reconcileOne(row: WorkspaceSkillEntity): Promise<void> {
    if (!row.source_url) return; // defensive — the `provenance:'git'` filter should already guarantee this
    const token = row.source_url.startsWith('https://github.com/')
      ? await this.creds.githubToken(row.org_id)
      : undefined;
    const head = await this.git.resolveRemoteRef(row.source_url, row.source_ref ?? undefined, token);

    if (head.sha === row.installed_sha) {
      if (row.update_available) {
        await this.skills.update({ org_id: row.org_id, scope: row.scope, name: row.name }, { update_available: false });
      }
      return; // already current
    }

    if (row.update_policy === 'track-ref') {
      await this.installer.install({
        orgId: row.org_id,
        scope: row.scope,
        sourceUrl: row.source_url,
        ref: row.source_ref ?? undefined,
        subpath: row.source_subpath ?? undefined,
        updatePolicy: row.update_policy,
        surfaces: row.surfaces,
      });
      this.logger.log(
        `auto-updated skill org=${row.org_id} scope=${row.scope} name=${row.name} → ${head.sha.slice(0, 8)}`,
      );
      if (row.update_available) {
        await this.skills.update({ org_id: row.org_id, scope: row.scope, name: row.name }, { update_available: false });
      }
      return;
    }

    // `pinned` / `manual`: badge only — the row is applied via `applyNow`, not here.
    if (!row.update_available) {
      await this.skills.update({ org_id: row.org_id, scope: row.scope, name: row.name }, { update_available: true });
    }
  }
}
