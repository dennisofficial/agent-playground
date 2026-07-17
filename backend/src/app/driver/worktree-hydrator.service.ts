import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeForbiddenPaths } from '../git/hydration-sidecar';
import { LocalGitService } from '../git/local-git.service';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { WorkspaceSecretFileStore } from '../onboarding/workspace-secret.store';
import { isExternalMountPath, type MountSpec } from '../sandbox/container-paths';
import { resolveExternalMountTarget, resolveSafeTarget } from './worktree-path-guard';

export interface HydrateInput {
  worktreePath: string;
  orgId: string;
  repoDbId?: string;
}

@Injectable()
export class WorktreeHydrator {
  private readonly logger = new Logger(WorktreeHydrator.name);
  private tmpCounter = 0;

  constructor(
    private readonly git: LocalGitService,
    private readonly secrets: WorkspaceSecretFileStore,
    private readonly config: WorkspaceConfigStore,
  ) {}

  private async safeListMounts(orgId: string, repoId: string): Promise<MountSpec[]> {
    try {
      return await this.config.listMounts(orgId, repoId);
    } catch (err) {
      this.logger.warn(
        `worktree mount config read failed for repo=${repoId} (treating as none this pass): ${(err as Error).message}`,
      );
      return [];
    }
  }

  async resolveMounts(orgId: string, repoId: string, worktreePath: string): Promise<MountSpec[]> {
    const mounts = await this.safeListMounts(orgId, repoId);
    const out: MountSpec[] = [];
    for (const m of mounts) {
      try {
        if (isExternalMountPath(m.path)) resolveExternalMountTarget(m.path);
        else resolveSafeTarget(worktreePath, m.path);
        out.push(m);
      } catch (err) {
        this.logger.warn(`worktree mount "${m.path}" rejected: ${(err as Error).message}`);
      }
    }
    return out;
  }

  async computeSig(worktreePath: string, orgId: string, repoDbId?: string): Promise<string> {
    const mounts = repoDbId ? await this.safeListMounts(orgId, repoDbId) : [];
    const secretFiles = repoDbId ? await this.secrets.listForRepo(orgId, repoDbId) : [];
    const files = secretFiles.map((f) => `${f.path}:${f.updatedAt}`).sort();
    const mountSig = mounts.map((m) => `${m.path}:${m.mode}`).sort();
    return createHash('sha256')
      .update(JSON.stringify({ mounts: mountSig, files }))
      .digest('hex');
  }

  async hydrateFiles(
    input: HydrateInput,
  ): Promise<{ forbiddenPaths: string[]; notices: string[] }> {
    const { worktreePath, orgId, repoDbId } = input;
    const forbidden: string[] = [];
    const notices: string[] = [];
    const note = (msg: string): void => {
      notices.push(msg);
      this.logger.warn(`${msg} (${worktreePath})`);
    };

    let mounts: MountSpec[] = [];
    if (repoDbId) {
      try {
        mounts = await this.config.listMounts(orgId, repoDbId);
      } catch (err) {
        note(
          `workspace config unavailable — mounts skipped this hydration (will retry next attach): ${(err as Error).message}`,
        );
      }
    }

    if (repoDbId) {
      for (const f of await this.secrets.listForRepo(orgId, repoDbId)) {
        let target: string;
        try {
          target = resolveSafeTarget(worktreePath, f.path);
        } catch (err) {
          note(`workspace secret "${f.path}" rejected (unsafe path): ${(err as Error).message}`);
          continue;
        }
        const value = await this.secrets.read(orgId, repoDbId, f.path);
        if (value == null) {
          note(
            `workspace secret "${f.path}" disappeared before it could be rendered (concurrent change) — skipping`,
          );
          continue;
        }
        if (!(await this.git.isIgnored(worktreePath, f.path))) {
          note(
            `workspace secret target "${f.path}" is NOT gitignored — refusing to render (it would leak into the PR); add it to .gitignore`,
          );
          continue;
        }
        await this.writeAtomic(target, value, 0o600);
        forbidden.push(f.path);
      }
    }

    for (const m of mounts) {
      try {
        if (isExternalMountPath(m.path)) resolveExternalMountTarget(m.path);
        else resolveSafeTarget(worktreePath, m.path);
      } catch (err) {
        note(`worktree mount "${m.path}" rejected (unsafe path): ${(err as Error).message}`);
      }
    }

    await writeForbiddenPaths(worktreePath, forbidden);
    if (forbidden.length) {
      this.logger.log(`hydrated ${forbidden.length} file(s) into ${worktreePath}`);
    }
    return { forbiddenPaths: forbidden, notices };
  }

  private async writeAtomic(target: string, content: string, mode: number): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.atlas-tmp-${process.pid}-${this.tmpCounter++}`;
    await writeFile(tmp, content, { mode });
    await rename(tmp, target);
  }
}
