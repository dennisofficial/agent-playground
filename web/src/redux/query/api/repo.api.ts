import { getRealtimeClient } from '@/lib/realtime/realtime-client';
import { makeSocketListOpener, streamList } from '@workspace/pg-realtime/rtk';
import type {
  ConnectedRepo,
  ConnectRepoDto,
  DisconnectRepoResult,
  RepoBranches,
  RepoView,
  UpdateRepoDto,
} from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';

export const repoApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getOrgRepos: build.query<RepoView[], string>({
      // Socket-only: the realtime feed delivers the full initial snapshot on subscribe.
      queryFn: () => ({ data: [] }),
      providesTags: (_result, _error, orgId) => [{ type: EBaseApiCacheTags.REPO, id: orgId }],
      onCacheEntryAdded: (orgId, api) =>
        streamList<RepoView>({
          url: 'repos',
          open: makeSocketListOpener(getRealtimeClient(), 'repos', { filter: { orgId } }),
          lifecycle: api,
        }),
    }),

    // Every repo across the caller's orgs (member-scoped, RLS) — the create-job picker + the sidebar's
    // repoId→name map. No org in the path; an unfiltered subscription is naturally scoped by the `repos`
    // guard, so this is the live equivalent of the old `GET /repos` (listAll).
    getAllRepos: build.query<RepoView[], void>({
      // Socket-only: the realtime feed delivers the full initial snapshot on subscribe.
      queryFn: () => ({ data: [] }),
      providesTags: [EBaseApiCacheTags.REPO],
      onCacheEntryAdded: (_arg, api) =>
        streamList<RepoView>({
          url: 'repos',
          open: makeSocketListOpener(getRealtimeClient(), 'repos'),
          lifecycle: api,
        }),
    }),

    // Item ops are addressed by repoId alone — the backend scopes them to the caller's orgs
    // (OrgScope), so no orgId is needed in the path.
    getRepoBranches: build.query<RepoBranches, { repoId: string }>({
      query: ({ repoId }) => ({
        url: `/repos/${repoId}/branches`,
        method: 'GET',
      }),
    }),

    connectRepo: build.mutation<ConnectedRepo, { orgId: string; body: ConnectRepoDto }>({
      query: ({ orgId, body }) => ({
        url: `/orgs/${orgId}/repos`,
        method: 'POST',
        data: body,
      }),
      invalidatesTags: [EBaseApiCacheTags.SESSION],
    }),

    updateRepo: build.mutation<ConnectedRepo, { repoId: string; body: UpdateRepoDto }>({
      query: ({ repoId, body }) => ({
        url: `/repos/${repoId}`,
        method: 'PATCH',
        data: body,
      }),
    }),

    revalidateRepo: build.mutation<ConnectedRepo, { repoId: string }>({
      query: ({ repoId }) => ({
        url: `/repos/${repoId}/revalidate`,
        method: 'POST',
      }),
    }),

    disconnectRepo: build.mutation<DisconnectRepoResult, { repoId: string }>({
      query: ({ repoId }) => ({ url: `/repos/${repoId}`, method: 'DELETE' }),
      invalidatesTags: [EBaseApiCacheTags.SESSION],
    }),
  }),
});

export const {
  useGetOrgReposQuery,
  useGetAllReposQuery,
  useGetRepoBranchesQuery,
  useConnectRepoMutation,
  useUpdateRepoMutation,
  useRevalidateRepoMutation,
  useDisconnectRepoMutation,
} = repoApi;
