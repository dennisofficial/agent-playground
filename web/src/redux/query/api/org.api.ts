import { getRealtimeClient } from '@/lib/realtime/realtime-client';
import { makeSocketListOpener, streamList } from '@workspace/pg-realtime/rtk';
import type { CreateOrgDto, MemberView, OrgSummary, UpdateOrgDto } from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';

export const orgApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getOrgs: build.query<OrgSummary[], void>({
      query: () => ({ url: `/orgs`, method: 'GET' }),
      providesTags: [EBaseApiCacheTags.SESSION],
      onCacheEntryAdded: (_arg, api) =>
        streamList<OrgSummary>({
          url: 'org_summary',
          open: makeSocketListOpener(getRealtimeClient(), 'org_summary'),
          lifecycle: api,
        }),
    }),
    getOrgMembers: build.query<MemberView[], string>({
      query: (orgId) => ({ url: `/orgs/${orgId}/members`, method: 'GET' }),
      providesTags: (_result, _error, orgId) => [{ type: EBaseApiCacheTags.ORG_MEMBER, id: orgId }],
      onCacheEntryAdded: (orgId, api) =>
        streamList<MemberView>({
          url: 'org_members',
          open: makeSocketListOpener(getRealtimeClient(), 'org_members', { filter: { orgId } }),
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
  useGetOrgsQuery,
  useGetOrgMembersQuery,
  useCreateOrgMutation,
  useUpdateOrgMutation,
  useDeleteOrgMutation,
} = orgApi;
