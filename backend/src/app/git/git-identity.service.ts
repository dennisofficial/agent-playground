import { Injectable } from '@nestjs/common';
import type { SandboxGitIdentity } from '@shared/engine/engine.types';
import { GithubPrService } from './github-pr.service';

@Injectable()
export class GitIdentityService {
  private readonly cache = new Map<string, SandboxGitIdentity>();
  constructor(private readonly github: GithubPrService) {}

  async resolve(token: string | undefined): Promise<SandboxGitIdentity | undefined> {
    if (!token) return undefined;
    if (this.cache.has(token)) return this.cache.get(token);
    let u: Awaited<ReturnType<GithubPrService['getAuthenticatedUser']>>;
    try {
      u = await this.github.getAuthenticatedUser(token);
    } catch {
      return undefined;
    }
    if (!u) return undefined;
    const identity: SandboxGitIdentity = {
      name: u.name?.trim() || u.login,
      email: `${u.id}+${u.login}@users.noreply.github.com`,
    };
    this.cache.set(token, identity);
    return identity;
  }
}
