import type { EnvService } from '@core/config/env/env.service';

/**
 * Whether a repo (identified by its SLUG) is the Atlas repo itself, per the configured `ATLAS_REPO_SLUG`.
 * Not hardcoded — the prod slug is set in compose; unset (dev) means NO repo is ever treated as Atlas
 * (fail-closed). The caller MUST pass a repo SLUG, never a repo UUID (a UUID never equals the slug, so
 * passing one silently disables the feature everywhere).
 */
export function isAtlasRepo(repoSlug: string, env: EnvService): boolean {
  const slug = env.get('ATLAS_REPO_SLUG');
  return !!slug && repoSlug === slug;
}
