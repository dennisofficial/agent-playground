import { SecretCipherService } from '@lib/crypto/secret-cipher.service';
import { Injectable } from '@nestjs/common';
import { WorkspaceSecretFileRepo } from '../../_lib/database/entities/workspace-secret-file.entity';
import { OrgService } from '../org/org.service';

/**
 * Per-repo secret-file CRUD (encrypted, write-only value) — the same AES-256-GCM pattern as
 * `org_credentials`. SHELL this pass — deps wired (cipher + repo + tenancy), bodies deferred to the logic
 * pass (list path+label only / add-encrypt / remove).
 */
@Injectable()
export class SecretFileService {
  constructor(
    private readonly secretFiles: WorkspaceSecretFileRepo,
    private readonly cipher: SecretCipherService,
    private readonly orgs: OrgService,
  ) {}
}
