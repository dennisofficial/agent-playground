import type { AutoApproveMode } from '../types/auto-approve';

/**
 * An organization the current user belongs to. Returned on the session payload
 * (`GET /auth/session`) and by the org CRUD endpoints. `role` is the *caller's*
 * role in this org ('owner' | 'member'), not a property of the org itself.
 */
export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  status: string; // 'onboarding' | 'active' | 'suspended'
  role: string; // caller's membership role: 'owner' | 'member'
  defaultAutoApproveMode: AutoApproveMode;
  defaultAutoMerge: boolean;
}

/** A member of an organization, returned by `GET /web/orgs/:orgId/members`. */
export interface MemberView {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}
