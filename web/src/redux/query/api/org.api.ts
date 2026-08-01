import { pgbase } from '@/lib/pgbase/client';
import { orgSummaryOf } from '@/lib/pgbase/adapters';
import type { CreateOrgDto, MemberView, OrgSummary, UpdateOrgDto } from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';

/**
 * `Organization` doesn't carry the caller's role — that's on `OrganizationMember` — so `org_summary`
 * (`Organization ⋈ OrganizationMember` on the caller's own membership rows) used to be a server-composed
 * view specifically to avoid a client-side join. pgbase has no live joins, so it's now two own-column
 * subscriptions (`Organization` — RLS already scopes an unfiltered read to the caller's orgs —
 * and `OrganizationMember` filtered to `userId`) joined client-side on `orgId`, same pattern as `getJob`
 * in `jobs.api.ts`. An org whose membership row hasn't arrived yet (or has) is a genuinely transient
 * mismatch between the two subscriptions rather than a race the server used to hide — it's dropped
 * until both sides agree, since `OrgSummary.role` isn't optional.
 */
function composeOrgSummaries(
  orgs: readonly Parameters<typeof orgSummaryOf>[0][],
  members: readonly { orgId: string; role: string }[],
): OrgSummary[] {
  const roleByOrgId = new Map(members.map((m) => [m.orgId, m.role] as const));
  return orgs.flatMap((org) => {
    const role = roleByOrgId.get(org.id);
    return role === undefined ? [] : [orgSummaryOf(org, role)];
  });
}

export const orgApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getOrgs: build.query<OrgSummary[], string | undefined>({
      queryFn: async (userId) => {
        if (!userId) return { data: [] };
        const orgSub = pgbase.Organization.createSubscription();
        const memberSub = pgbase.OrganizationMember.createSubscription();
        try {
          const [orgs, members] = await Promise.all([
            orgSub.query({}),
            memberSub.query({ where: { userId } }),
          ]);
          return { data: composeOrgSummaries(orgs, members), meta: { orgSub, memberSub } };
        } catch (err) {
          orgSub.close();
          memberSub.close();
          return { error: { message: err instanceof Error ? err.message : String(err) } };
        }
      },
      providesTags: [EBaseApiCacheTags.SESSION],
      onCacheEntryAdded: async (_userId, api) => {
        const { meta } = await api.cacheDataLoaded;
        const subs = meta as
          | {
              orgSub: ReturnType<typeof pgbase.Organization.createSubscription>;
              memberSub: ReturnType<typeof pgbase.OrganizationMember.createSubscription>;
            }
          | undefined;
        if (!subs) return;

        let orgs = subs.orgSub.getSnapshot();
        let members = subs.memberSub.getSnapshot();
        const recompute = () => api.updateCachedData(() => composeOrgSummaries(orgs, members));

        const offOrgs = subs.orgSub.subscribe((rows) => {
          orgs = rows;
          recompute();
        });
        const offMembers = subs.memberSub.subscribe((rows) => {
          members = rows;
          recompute();
        });

        await api.cacheEntryRemoved;
        offOrgs();
        offMembers();
        subs.orgSub.close();
        subs.memberSub.close();
      },
    }),

    // `MemberView` needs `email`/`name`, which live on `User` — NO_CLIENT_ACCESS under pgbase, so
    // there is no live-query or one-shot read path to it from the browser at all. A deliberate CQS
    // exception: a plain REST read (`OrgController#members` → `OrgService.membersOf`), not a
    // subscription, so this does NOT go through `liveListEndpoint`/pgbase.
    getOrgMembers: build.query<MemberView[], string>({
      query: (orgId) => ({ url: `/orgs/${orgId}/members`, method: 'GET' }),
      providesTags: (_result, _error, orgId) => [{ type: EBaseApiCacheTags.ORG_MEMBER, id: orgId }],
    }),

    createOrg: build.mutation<OrgSummary, CreateOrgDto>({
      query: (body) => ({ url: '/orgs', method: 'POST', data: body }),
      invalidatesTags: [EBaseApiCacheTags.SESSION],
    }),
    updateOrg: build.mutation<OrgSummary, { orgId: string; body: UpdateOrgDto }>({
      query: ({ orgId, body }) => ({
        url: `/orgs/${orgId}`,
        method: 'PATCH',
        data: body,
      }),
      invalidatesTags: [EBaseApiCacheTags.SESSION],
    }),
    deleteOrg: build.mutation<{ ok: true }, string>({
      query: (orgId) => ({ url: `/orgs/${orgId}`, method: 'DELETE' }),
      invalidatesTags: [EBaseApiCacheTags.SESSION],
    }),
  }),
});

export const {
  useGetOrgsQuery,
  useGetOrgMembersQuery,
  useCreateOrgMutation,
  useUpdateOrgMutation,
  useDeleteOrgMutation,
} = orgApi;
