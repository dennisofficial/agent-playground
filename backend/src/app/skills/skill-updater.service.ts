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
import { LeaderElectionService } from '../cluster/leader-election.service';
import { LocalGitService } from '../git/local-git.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { WorkspaceSkillEntity } from '../persistence/entities';
import { SkillInstallerService } from './skill-installer.service';

const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const SKILL_UPDATER_INTERVAL = 'skills:skill-updater';

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
    if (this.scheduler?.doesExist('interval', SKILL_UPDATER_INTERVAL)) {
      this.scheduler.deleteInterval(SKILL_UPDATER_INTERVAL);
    }
  }

  async reconcileAll(): Promise<void> {
    const rows = await this.skills.find({ where: { provenance: 'git' } });
    for (const row of rows) {
      await this.reconcileOne(row).catch((err) =>
        this.logger.warn(
          `update-check failed org=${row.org_id} scope=${row.scope} name=${row.name}: ${err}`,
        ),
      );
    }
  }

  reconcileOrgAsync(orgId: string): void {
    void this.skills
      .find({ where: { org_id: orgId, provenance: 'git' } })
      .then((rows) =>
        Promise.all(
          rows.map((row) =>
            this.reconcileOne(row).catch((err) =>
              this.logger.warn(
                `update-check failed org=${row.org_id} scope=${row.scope} name=${row.name}: ${err}`,
              ),
            ),
          ),
        ),
      )
      .catch((err) => this.logger.warn(`update-check failed org=${orgId}: ${err}`));
  }

  async applyNow(orgId: string, scope: string, name: string): Promise<void> {
    const row = await this.skills.findOne({
      where: { org_id: orgId, scope, name },
    });
    if (!row) throw new BadRequestException(`unknown skill '${name}'`);
    if (row.provenance !== 'git' || !row.source_url) {
      throw new BadRequestException(
        `'${name}' has no git source to update from (provenance=${row.provenance})`,
      );
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
      await this.skills.update(
        { org_id: row.org_id, scope: row.scope, name: row.name },
        { update_available: false },
      );
    }
  }

  private async reconcileOne(row: WorkspaceSkillEntity): Promise<void> {
    if (!row.source_url) return; // defensive — the `provenance:'git'` filter should already guarantee this
    const token = row.source_url.startsWith('https://github.com/')
      ? await this.creds.hostGithubToken(row.org_id)
      : undefined;
    const head = await this.git.resolveRemoteRef(
      row.source_url,
      row.source_ref ?? undefined,
      token,
    );

    if (head.sha === row.installed_sha) {
      if (row.update_available) {
        await this.skills.update(
          { org_id: row.org_id, scope: row.scope, name: row.name },
          { update_available: false },
        );
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
        await this.skills.update(
          { org_id: row.org_id, scope: row.scope, name: row.name },
          { update_available: false },
        );
      }
      return;
    }

    if (!row.update_available) {
      await this.skills.update(
        { org_id: row.org_id, scope: row.scope, name: row.name },
        { update_available: true },
      );
    }
  }
}
