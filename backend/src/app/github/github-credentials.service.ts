import { Injectable } from '@nestjs/common';
import { ECredentialKey } from '@workspace/shared';
import { CredentialsService } from '../credentials/credentials.service';

/**
 * Resolves the GitHub credential Atlas uses for an org's API/git calls. Today that's the org's stored
 * PAT (from the credentials vault); this is the single seam where the PAT-vs-GitHub-App switch will live
 * once the App connect flow lands, so callers never learn which mode produced the token.
 */
@Injectable()
export class GithubCredentialsService {
  constructor(private readonly credentials: CredentialsService) {}

  /** The bearer token for the org's GitHub calls, or `null` when the org has no usable credential. */
  resolveToken(orgId: string): Promise<string | null> {
    return this.credentials.get(orgId, ECredentialKey.GITHUB_PAT);
  }

  /** Whether the org has a usable GitHub credential (no decryption). */
  hasToken(orgId: string): Promise<boolean> {
    return this.credentials.has(orgId, ECredentialKey.GITHUB_PAT);
  }
}
