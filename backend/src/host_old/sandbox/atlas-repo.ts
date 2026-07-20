import type { EnvService } from '@core/config/env/env.service';

export function isAtlasRepo(repoSlug: string, env: EnvService): boolean {
  const slug = env.get('ATLAS_REPO_SLUG');
  return !!slug && repoSlug === slug;
}
