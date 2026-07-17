"use client";

import { useGetSessionQuery } from "@/redux/query/api/auth.api";
import type { AutoApproveMode } from "@workspace/shared";
import { useMemo } from "react";
import { adaptQuery, type QueryResultLike } from "./_stub";

/**
 * An org the operator belongs to, as carried on the session (`GET /auth/session`).
 *
 * NOTE (contract drift): the backend no longer returns `slug`, and replaced
 * `defaultAutoApproveMode` with the three booleans `defaultAutoApprove` / `defaultAutoShip` /
 * `defaultAutoMerge`. `useCurrentUser` bridges the new shape to this (still web-local) type until
 * the web is updated to consume `@workspace/shared`'s `OrgSummary` directly.
 */
export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  role: string;
  defaultAutoApproveMode: AutoApproveMode;
  defaultAutoMerge: boolean;
}

/** The authenticated operator + every org they belong to, from `GET /auth/session`. */
export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  orgs: OrgSummary[];
}

/** Bridge the backend's two-boolean model onto the legacy 4-value mode this UI still reads. */
function toApproveMode(autoApprove: boolean, autoShip: boolean): AutoApproveMode {
  if (autoApprove && autoShip) return "both";
  if (autoApprove) return "plan";
  if (autoShip) return "ship";
  return "off";
}

/**
 * The current operator's session (identity + orgs) via RTK Query (`GET /auth/session`). Returns the
 * TanStack-shaped result the shell already consumes; a 401 leaves `data` undefined and callers fall back.
 */
export function useCurrentUser(): QueryResultLike<CurrentUser> {
  const result = useGetSessionQuery();
  const mapped = useMemo<CurrentUser | undefined>(() => {
    const s = result.data;
    if (!s) return undefined;
    return {
      id: s.id,
      email: s.email,
      name: s.name,
      orgs: s.orgs.map((o) => ({
        id: o.id,
        slug: o.id, // backend dropped slug; fall back to id until the UI stops needing it
        name: o.name,
        status: o.status,
        role: o.role,
        defaultAutoApproveMode: toApproveMode(o.defaultAutoApprove, o.defaultAutoShip),
        defaultAutoMerge: o.defaultAutoMerge,
      })),
    };
  }, [result.data]);
  return adaptQuery<CurrentUser>({ ...result, data: mapped });
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
