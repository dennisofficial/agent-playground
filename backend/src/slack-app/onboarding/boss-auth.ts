import type { EnvService } from '@core/config/env/env.service';
import type { TenantStore } from '../tenant.store';

/**
 * True iff `userId` is the workspace OWNER — the user who installed the app (`tenant.installedBy`),
 * or the `APPROVAL_BOSS_USER_ID` fallback. Shared by the card adapters that gate boss-only modals
 * (project onboarding, key rotation), so "only Dennis can do this" is authorized identically and
 * fail-closed (unknown user / lookup error → false). Extracted from ProjectOnboardCardsService.
 */
export async function isWorkspaceBoss(
  tenants: TenantStore,
  env: EnvService,
  teamId: string,
  userId: string | undefined,
): Promise<boolean> {
  if (!userId) return false;
  const tenant = await tenants.get(teamId).catch(() => undefined);
  const boss = tenant?.installedBy ?? env.get('APPROVAL_BOSS_USER_ID');
  return !!boss && boss === userId;
}
