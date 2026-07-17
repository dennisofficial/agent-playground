import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LeaderElectionService } from '../cluster/leader-election.service';
import { LocalGitService } from '../git/local-git.service';
import {
  managedGitSkillDirHost,
  managedGitSkillsRootHost,
} from './skill-store-paths';
import {
  buildSystemSkills,
  type SystemSkillGitSource,
} from './system-skill-registry';

/** How often the leader re-checks every git-sourced managed skill against its remote — mirrors
 *  `SkillUpdaterService.RECONCILE_INTERVAL_MS`; this tier moves just as rarely. */
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
/** SchedulerRegistry interval name (process-unique) for the leader-gated reconcile sweep. */
const MANAGED_SKILL_SYNC_INTERVAL = 'skills:managed-skill-sync';

/**
 * LEADER-ONLY sync for the GIT-SOURCED half of the system-tier managed skills (`system-skill-registry.ts`
 * entries carrying a `git` source, e.g. `playwright-cli`) — the global, org-agnostic counterpart of
 * `SkillUpdaterService` (which is per-org, DB-row-backed). Runs on boot/promotion AND a cadence, reusing
 * the SAME clone+vendor mechanics as `SkillInstallerService` (shallow-clone a scratch dir, copy the
 * subpath, never a submodule) but writing into the reserved `_managed` global store
 * (`skill-store-paths.ts`'s `managedGitSkillsRootHost`) instead of an org-scoped one, and with no
 * `workspace_skills` row — the registry entry itself IS the durable record, so "is it current" is tracked
 * by a sha marker sidecar file instead of a DB column.
 *
 * Always clones ANONYMOUSLY (no `CredentialResolver` dependency) — this tier is global, so there is no org
 * whose PAT would apply; every entry here must be a public repo. Fail-soft per entry: a network hiccup or a
 * bad subpath is logged and skipped, never thrown past `syncAll` — this must not be able to wedge boot.
 */
@Injectable()
export class ManagedSkillSyncService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ManagedSkillSyncService.name);
  private promoteSub?: { unsubscribe(): void };
  private demoteSub?: { unsubscribe(): void };

  constructor(
    private readonly git: LocalGitService,
    private readonly election: LeaderElectionService,
    private readonly env: EnvService,
    // Prod always injects the scheduler (global ScheduleModule); unit tests omit it and never promote, so
    // the sync never starts there.
    @Optional() private readonly scheduler?: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.get('POSTGRES_DB')?.endsWith('_test')) {
      this.logger.log('managed-skill sync off (test database)');
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
    if (this.scheduler.doesExist('interval', MANAGED_SKILL_SYNC_INTERVAL))
      return;
    void this.syncAll(); // boot/promotion sweep
    const iv = setInterval(() => void this.syncAll(), RECONCILE_INTERVAL_MS);
    iv.unref?.(); // never keep the process alive (SchedulerRegistry does not unref for us)
    this.scheduler.addInterval(MANAGED_SKILL_SYNC_INTERVAL, iv);
    this.logger.log('managed-skill sync started (leader)');
  }

  private stop(): void {
    // deleteInterval clears the interval AND removes it from the registry.
    if (this.scheduler?.doesExist('interval', MANAGED_SKILL_SYNC_INTERVAL)) {
      this.scheduler.deleteInterval(MANAGED_SKILL_SYNC_INTERVAL);
    }
  }

  /** Sync every git-sourced registry entry. Fail-soft per entry — see class doc. */
  async syncAll(): Promise<void> {
    for (const s of buildSystemSkills()) {
      if (!s.git) continue;
      await this.syncOne(s.name, s.git).catch((err) =>
        this.logger.warn(
          `managed-skill sync failed name=${s.name} url=${s.git?.url}: ${err}`,
        ),
      );
    }
  }

  private root(): string | undefined {
    return this.env.get('SKILLS_ROOT');
  }

  /** The sha-marker sidecar for one entry — a dotfile SIBLING of its vendored dir (never inside it, so it
   *  can never leak into the symlinked skill content the SDK reads). */
  private shaMarkerPath(name: string): string {
    return join(
      managedGitSkillsRootHost(this.root()),
      `.${name.replace(/[^a-z0-9_-]/gi, '_')}.sha`,
    );
  }

  private async syncOne(
    name: string,
    source: SystemSkillGitSource,
  ): Promise<void> {
    const head = await this.git.resolveRemoteRef(source.url, source.ref);
    const marker = this.shaMarkerPath(name);
    const current = existsSync(marker)
      ? readFileSync(marker, 'utf8').trim()
      : undefined;
    if (current === head.sha) return; // already current — the common path on every non-boot tick

    const tmpDir = await mkdtemp(join(tmpdir(), 'atlas-managed-skill-sync-'));
    try {
      await this.git.shallowCloneToPath(source.url, head.ref, tmpDir);
      const srcDir = join(tmpDir, source.subpath);
      if (!existsSync(join(srcDir, 'SKILL.md'))) {
        throw new Error(
          `no SKILL.md at subpath '${source.subpath}' in ${source.url}@${head.ref}`,
        );
      }
      const dest = managedGitSkillDirHost(this.root(), name);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(srcDir, dest, { recursive: true }); // full fidelity — references/scripts, all of it
      writeFileSync(marker, head.sha, 'utf8');
      this.logger.log(
        `synced managed skill '${name}' from ${source.url}@${head.ref} → ${head.sha.slice(0, 8)}`,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch((err) =>
        this.logger.warn(`failed to clean up scratch clone ${tmpDir}: ${err}`),
      );
    }
  }
}
