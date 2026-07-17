import { env } from "@/lib/env";
import type {
  ConnectedRepo,
  ConnectRepoDto,
  DisconnectRepoResult,
  RepoBranches,
  RepoView,
  UpdateRepoDto,
} from "@workspace/shared";
import { streamList } from "@workspace/pg-realtime/rtk";
import { baseApi, EBaseApiCacheTags } from "./baseApi";
import { sseOpener } from "./sse-opener";

const realtimeUrl = (path: string): string => `${env.NEXT_PUBLIC_BACKEND_URL}${path}`;

/**
 * Repos data layer. Reads are **realtime**: `getOrgRepos` seeds from the REST list, then
 * `streamList` keeps it live off the pg-realtime SSE feed (connect/update/revalidate/disconnect all
 * arrive as WAL deltas). Mutations therefore don't invalidate the list — the feed reconciles it —
 * they only invalidate `SESSION` where an org's status can shift.
 */
export const repoApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getOrgRepos: build.query<RepoView[], string>({
      query: (orgId) => ({ url: `/orgs/${orgId}/repos`, method: "GET" }),
      providesTags: (_result, _error, orgId) => [{ type: EBaseApiCacheTags.REPO, id: orgId }],
      onCacheEntryAdded: (orgId, api) =>
        streamList<RepoView>({
          url: realtimeUrl(`/orgs/${orgId}/repos/realtime`),
          open: sseOpener,
          lifecycle: api,
        }),
    }),

    // Item ops are addressed by repoId alone — the backend scopes them to the caller's orgs
    // (OrgScope), so no orgId is needed in the path.
    getRepoBranches: build.query<RepoBranches, { repoId: string }>({
      query: ({ repoId }) => ({ url: `/repos/${repoId}/branches`, method: "GET" }),
    }),

    connectRepo: build.mutation<ConnectedRepo, { orgId: string; body: ConnectRepoDto }>({
      query: ({ orgId, body }) => ({ url: `/orgs/${orgId}/repos`, method: "POST", data: body }),
      invalidatesTags: [EBaseApiCacheTags.SESSION],
    }),

    updateRepo: build.mutation<ConnectedRepo, { repoId: string; body: UpdateRepoDto }>({
      query: ({ repoId, body }) => ({ url: `/repos/${repoId}`, method: "PATCH", data: body }),
    }),

    revalidateRepo: build.mutation<ConnectedRepo, { repoId: string }>({
      query: ({ repoId }) => ({ url: `/repos/${repoId}/revalidate`, method: "POST" }),
    }),

    disconnectRepo: build.mutation<DisconnectRepoResult, { repoId: string }>({
      query: ({ repoId }) => ({ url: `/repos/${repoId}`, method: "DELETE" }),
      invalidatesTags: [EBaseApiCacheTags.SESSION],
    }),
  }),
});

export const {
  useGetOrgReposQuery,
  useGetRepoBranchesQuery,
  useConnectRepoMutation,
  useUpdateRepoMutation,
  useRevalidateRepoMutation,
  useDisconnectRepoMutation,
} = repoApi;
