"use client";

import { useGetSessionQuery } from "@/redux/query/api/auth.api";
import { type CurrentUserResponse, type OrgSummary } from "@workspace/shared";
import { useMemo } from "react";
import { adaptQuery, type QueryResultLike } from "./_stub";

// The org + session wire shapes now come straight from @workspace/shared (no web-local mirror).
export type { OrgSummary };
export type CurrentUser = CurrentUserResponse;

/** The current operator's session (identity + orgs) via RTK Query (`GET /auth/session`). */
export function useCurrentUser(): QueryResultLike<CurrentUser> {
  return adaptQuery(useGetSessionQuery());
}

/** The operator's orgs, split into owned vs joined for the rail (owned first, then joined). */
export function useOrgs() {
  const { data, isLoading, isError } = useCurrentUser();
  const orgs = useMemo(() => data?.orgs ?? [], [data]);
  const owned = useMemo(() => orgs.filter((o) => o.role === "owner"), [orgs]);
  const joined = useMemo(() => orgs.filter((o) => o.role !== "owner"), [orgs]);
  return { orgs, owned, joined, isLoading, isError };
}

/** Look up a single org from the session by id (the settings page targets one org). */
export function useOrg(orgId: string): OrgSummary | undefined {
  const { orgs } = useOrgs();
  return useMemo(() => orgs.find((o) => o.id === orgId), [orgs, orgId]);
}
