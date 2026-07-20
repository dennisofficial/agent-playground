import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { OrgWorkspaceSecretFileEntity } from '../persistence/entities';
import { decryptSecret, encryptSecret, loadSecretsKey } from './secret-cipher';

export interface WorkspaceSecretFileRef {
  repoId: string;
  path: string;
  label?: string | null;
}

export interface WorkspaceSecretFileVersion {
  path: string;
  label?: string | null;
  updatedAt: number;
}

@Injectable()
export class WorkspaceSecretFileStore {
  private readonly logger = new Logger(WorkspaceSecretFileStore.name);

  constructor(
    @InjectRepository(OrgWorkspaceSecretFileEntity, DB_CONNECTION)
    private readonly files: Repository<OrgWorkspaceSecretFileEntity>,
    private readonly env: EnvService,
  ) {}

  private key(): Buffer {
    return loadSecretsKey(this.env.get('SECRETS_ENCRYPTION_KEY'));
  }

  async list(orgId: string, repoId?: string): Promise<WorkspaceSecretFileRef[]> {
    const rows = await this.files.find({
      where: repoId ? { org_id: orgId, repo_id: repoId } : { org_id: orgId },
      select: ['repo_id', 'path', 'label'],
    });
    return rows.map((r) => ({
      repoId: r.repo_id,
      path: r.path,
      label: r.label ?? null,
    }));
  }

  async listForRepo(orgId: string, repoId: string): Promise<WorkspaceSecretFileVersion[]> {
    const rows = await this.files.find({
      where: { org_id: orgId, repo_id: repoId },
      select: ['path', 'label', 'updated_at'],
    });
    return rows.map((r) => ({
      path: r.path,
      label: r.label ?? null,
      updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
    }));
  }

  async read(orgId: string, repoId: string, path: string): Promise<string | null> {
    const row = await this.files.findOne({
      where: { org_id: orgId, repo_id: repoId, path },
    });
    return row ? decryptSecret(row.value_enc, this.key()) : null;
  }

  async write(
    orgId: string,
    repoId: string,
    path: string,
    value: string,
    label?: string | null,
  ): Promise<void> {
    const key = this.key();
    const row =
      (await this.files.findOne({
        where: { org_id: orgId, repo_id: repoId, path },
      })) ?? this.files.create({ org_id: orgId, repo_id: repoId, path });
    row.value_enc = encryptSecret(value, key);
    if (label !== undefined) row.label = label;
    await this.files.save(row);
    this.logger.log(`wrote workspace secret file org=${orgId} repo=${repoId} path=${path}`);
  }

  async delete(orgId: string, repoId: string, path: string): Promise<void> {
    await this.files.delete({ org_id: orgId, repo_id: repoId, path });
    this.logger.log(`deleted workspace secret file org=${orgId} repo=${repoId} path=${path}`);
  }
}
