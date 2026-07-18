import { env } from '@/lib/env';
import { streamList } from '@workspace/pg-realtime/rtk';
import type { CreateOrgDto, MemberView, OrgSummary, UpdateOrgDto } from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';
import { sseOpener } from './sse-opener';

/**
 * Org CRUD + members. The org *list* is not a dedicated endpoint — it rides on the
 * session payload (`getSession().orgs`), so create/update/delete invalidate SESSION.
 * The member list is a realtime feed (`streamList`) — invites/removals arrive as deltas.
 */
export const orgApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getOrgMembers: build.query<MemberView[], string>({
      query: (orgId) => ({ url: `/orgs/${orgId}/members`, method: 'GET' }),
      providesTags: (_result, _error, orgId) => [{ type: EBaseApiCacheTags.ORG_MEMBER, id: orgId }],
      onCacheEntryAdded: (orgId, api) =>
        streamList<MemberView>({
          url: new URL(`orgs/${orgId}/members/realtime`, env.NEXT_PUBLIC_BACKEND_URL).toString(),
          open: sseOpener,
          lifecycle: api,
        }),
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
  useGetOrgMembersQuery,
  useCreateOrgMutation,
  useUpdateOrgMutation,
  useDeleteOrgMutation,
} = orgApi;
