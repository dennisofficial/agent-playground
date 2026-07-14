"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AutoApproveMode } from "@workspace/shared";
import { env } from "@/lib/env";
import { fetchWithRefresh } from "./refresh";
import { qk } from "./query-keys";

/** An org the operator belongs to, as carried on the session (`GET /auth/session`). */
export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  /** `onboarding` until credentials + a repo are validated, then `active`. */
  status: string;
  /** The caller's role IN this org: `owner` | `member` (admin reserved). */
  role: string;
  /** Org-level defaults a new job inherits at creation unless the create request sets it explicitly. */
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

async function fetchCurrentUser(): Promise<CurrentUser> {
  // Direct, credentialed call to the Atlas app (the session cookie authorizes it). `fetchWithRefresh`
  // re-ups the access cookie + retries once if it expired mid-session. The session carries the caller's
  // orgs so the shell can render the org rail / settings without a second round-trip.
  const res = await fetchWithRefresh(
    `${env.NEXT_PUBLIC_HTTP_URL}/auth/session`,
    {
      headers: { accept: "application/json" },
    },
  );
  if (!res.ok) throw new Error(`session ${res.status}`);
  const body = (await res.json()) as Partial<CurrentUser>;
  return {
    id: body.id ?? "",
    email: body.email ?? "",
    name: body.name ?? null,
    orgs: Array.isArray(body.orgs) ? body.orgs : [],
  };
}

/**
 * The current operator's session (identity + orgs). Mounts only inside the authenticated shell, so the
 * session cookie is present; a 401 (e.g. just after sign-out) leaves `data` undefined and callers fall
 * back gracefully.
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: qk.session(),
    queryFn: fetchCurrentUser,
    staleTime: 60_000,
    retry: false,
  });
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
