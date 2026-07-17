import type { CreateOrgDto, MemberView, OrgSummary, UpdateOrgDto } from "@workspace/shared";
import { baseApi, EBaseApiCacheTags } from "./baseApi";

/**
 * Org CRUD + members. The org *list* is not a dedicated endpoint — it rides on the
 * session payload (`getSession().orgs`), so create/update/delete invalidate SESSION.
 */
export const orgApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getOrgMembers: build.query<MemberView[], string>({
      query: (orgId) => ({ url: `/web/orgs/${orgId}/members`, method: "GET" }),
      providesTags: (_result, _error, orgId) => [{ type: EBaseApiCacheTags.ORG_MEMBER, id: orgId }],
    }),
    createOrg: build.mutation<OrgSummary, CreateOrgDto>({
      query: (body) => ({ url: "/web/orgs", method: "POST", data: body }),
      invalidatesTags: [EBaseApiCacheTags.SESSION],
    }),
    updateOrg: build.mutation<OrgSummary, { orgId: string; body: UpdateOrgDto }>({
      query: ({ orgId, body }) => ({ url: `/web/orgs/${orgId}`, method: "PATCH", data: body }),
      invalidatesTags: [EBaseApiCacheTags.SESSION],
    }),
    deleteOrg: build.mutation<{ ok: true }, string>({
      query: (orgId) => ({ url: `/web/orgs/${orgId}`, method: "DELETE" }),
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
