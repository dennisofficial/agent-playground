'use client';

import { useGetSessionQuery } from '@/redux/query/api/auth.api';
import { useGetOrgsQuery } from '@/redux/query/api/org.api';
import { type CurrentUserResponse, type OrgSummary } from '@workspace/shared';
import { useMemo } from 'react';
import { adaptQuery, type QueryResultLike } from './_stub';

// The org + session wire shapes now come straight from @workspace/shared (no web-local mirror).
export type { OrgSummary };
export type CurrentUser = CurrentUserResponse;

export function useCurrentUser(): QueryResultLike<CurrentUser> {
  return adaptQuery(useGetSessionQuery());
}

// Server-composed org_summary (organizations ⋈ organization_members, role joined on the backend) —
// a single realtime resource, no client-side join/race. `orgs` stays [] until isLoading resolves, so
// callers must gate the "no organizations" empty state on isLoading (never show it while loading).
export function useOrgs() {
  const { data, isLoading, isError } = useGetOrgsQuery();
  const orgs = useMemo(() => data ?? [], [data]);
  const owned = useMemo(() => orgs.filter((o) => o.role === 'owner'), [orgs]);
  const joined = useMemo(() => orgs.filter((o) => o.role !== 'owner'), [orgs]);
  return { orgs, owned, joined, isLoading, isError };
}

export function useOrg(orgId: string): OrgSummary | undefined {
  const { orgs } = useOrgs();
  return useMemo(() => orgs.find((o) => o.id === orgId), [orgs, orgId]);
}
