import { env } from "@/lib/env";
import type { CurrentUserResponse, OrgSummary } from "@workspace/shared";
import { baseApi, EBaseApiCacheTags } from "./baseApi";
import { sseOpener } from "./sse-opener";

/**
 * Session read. Login / register / logout stay on the `@workspace/auth` singleton
 * (it owns cookie + auth-state lifecycle); this endpoint just surfaces the operator
 * identity + orgs (`GET /auth/session`) for the shell to render.
 *
 * The `orgs` list is **realtime**: the `/orgs/realtime` feed re-emits the full `OrgSummary[]`
 * (each tagged with the caller's role) on any change to the caller's orgs or memberships, patched
 * into `session.orgs`. Since `useOrgs`/`useOrg` derive from here, the switcher and the org settings
 * sections update live. A brand-new org still needs a SESSION refetch (createOrg invalidates it) to
 * bring the fresh membership into the feed's scope.
 */
export const authApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getSession: build.query<CurrentUserResponse, void>({
      query: () => ({ url: "/auth/session", method: "GET" }),
      providesTags: [EBaseApiCacheTags.SESSION],
      onCacheEntryAdded: async (_arg, api) => {
        const controller = new AbortController();
        try {
          await api.cacheDataLoaded;
          const stream = sseOpener(`${env.NEXT_PUBLIC_BACKEND_URL}/orgs/realtime`, {
            signal: controller.signal,
            onmessage: (ev) => {
              if (ev.event !== "data" || !ev.data) return;
              const rows = JSON.parse(ev.data) as Array<{ pk: string; row: OrgSummary }>;
              api.updateCachedData((draft) => {
                draft.orgs = rows.map((r) => r.row);
              });
            },
          });
          await api.cacheEntryRemoved;
          controller.abort();
          await stream.catch(() => undefined);
        } catch {
          controller.abort();
        }
      },
    }),
  }),
});

export const { useGetSessionQuery } = authApi;
