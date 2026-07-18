import type {
  CredentialPresence,
  SaveCredentialsDto,
  SaveCredentialsResult,
} from "@workspace/shared";
import { baseApi, EBaseApiCacheTags } from "./baseApi";

/**
 * The org credentials vault. Key-agnostic wire (`@workspace/shared` speaks only
 * `ECredentialKey`) — the settings UI's domain view/body mapping lives in
 * `web/src/lib/api/orgs.ts`, never here or in the backend.
 *
 * GET is member-gated and returns presence booleans only (secret values are never
 * returned). PUT is owner-gated; a first credential can flip the org
 * `onboarding → active`, so the save also invalidates SESSION.
 */
export const credentialsApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getCredentials: build.query<CredentialPresence, string>({
      query: (orgId) => ({ url: `/orgs/${orgId}/credentials`, method: "GET" }),
      providesTags: (_result, _error, orgId) => [
        { type: EBaseApiCacheTags.CREDENTIALS, id: orgId },
      ],
    }),
    saveCredentials: build.mutation<
      SaveCredentialsResult,
      { orgId: string; body: SaveCredentialsDto }
    >({
      query: ({ orgId, body }) => ({
        url: `/orgs/${orgId}/credentials`,
        method: "PUT",
        data: body,
      }),
      invalidatesTags: (_result, _error, { orgId }) => [
        { type: EBaseApiCacheTags.CREDENTIALS, id: orgId },
        EBaseApiCacheTags.SESSION,
      ],
    }),
  }),
});

export const { useGetCredentialsQuery, useSaveCredentialsMutation } =
  credentialsApi;
