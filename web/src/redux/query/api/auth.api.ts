import { getRealtimeClient } from '@/lib/realtime/realtime-client';
import type { LiveQuery } from '@workspace/pg-realtime/client';
import { EOrgRole } from '@workspace/shared';
import type { CurrentUserResponse, OrgSummary } from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';

interface OrganizationRow extends Record<string, unknown> {
  id: string;
  name: string;
  status: string;
  defaultAutoApprove: boolean;
  defaultAutoShip: boolean;
  defaultAutoMerge: boolean;
}

interface OrganizationMemberRow extends Record<string, unknown> {
  orgId: string;
  userId: string;
  role: string;
}

export const authApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getSession: build.query<CurrentUserResponse, void>({
      query: () => ({ url: '/auth/session', method: 'GET' }),
      providesTags: [EBaseApiCacheTags.SESSION],
      onCacheEntryAdded: async (_arg, api) => {
        try {
          const { data: session } = await api.cacheDataLoaded;
          const currentUserId = session.id;

          const client = getRealtimeClient();
          const orgsQuery: LiveQuery<OrganizationRow> = client.query('organizations');
          const membersQuery: LiveQuery<OrganizationMemberRow> =
            client.query('organization_members');

          const rebuild = (): void => {
            const members = membersQuery.get();
            api.updateCachedData((draft) => {
              draft.orgs = orgsQuery.get().map(
                (org): OrgSummary => ({
                  ...org,
                  role:
                    members.find((m) => m.userId === currentUserId && m.orgId === org.id)
                      ?.role ?? EOrgRole.MEMBER,
                }),
              );
            });
          };

          const unsubOrgs = orgsQuery.subscribe(rebuild);
          const unsubMembers = membersQuery.subscribe(rebuild);
          rebuild();

          await api.cacheEntryRemoved;
          unsubOrgs();
          unsubMembers();
        } catch {
          // cacheEntryRemoved before cacheDataLoaded resolves — nothing to tear down.
        }
      },
    }),
  }),
});

export const { useGetSessionQuery } = authApi;
