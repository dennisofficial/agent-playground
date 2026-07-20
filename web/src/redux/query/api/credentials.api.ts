import type { CredentialPresence, SaveCredentialsResult } from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';

export interface CredentialPresenceView {
  hasAnthropic: boolean;
  hasOpenai: boolean;
  hasGithub: boolean;
  /** Anthropic key server-probe verdict — not available until the engine module; mirrors presence for now. */
  llmValidated: boolean;
  /** GitHub credential mode; the real value comes from github-app status. Defaults to 'pat'. */
  githubAuthMode: 'pat' | 'app';
}

export interface SaveCredentialsBody {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  githubPat?: string;
}

function toCredentialPresenceView(p: CredentialPresence): CredentialPresenceView {
  return {
    hasAnthropic: p.anthropic,
    hasOpenai: p.openai,
    hasGithub: p.github,
    llmValidated: p.anthropic,
    githubAuthMode: 'pat',
  };
}

export const credentialsApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getCredentials: build.query<CredentialPresenceView, string>({
      query: (orgId) => ({ url: `/orgs/${orgId}/credentials`, method: 'GET' }),
      transformResponse: toCredentialPresenceView,
      providesTags: (_result, _error, orgId) => [
        { type: EBaseApiCacheTags.CREDENTIALS, id: orgId },
      ],
    }),
    saveCredentials: build.mutation<
      SaveCredentialsResult,
      { orgId: string; body: SaveCredentialsBody }
    >({
      query: ({ orgId, body }) => ({
        url: `/orgs/${orgId}/credentials`,
        method: 'PUT',
        // Drop empty values — the backend leaves omitted/blank fields untouched (a blank field is a no-op).
        data: {
          anthropicApiKey: body.anthropicApiKey || undefined,
          openaiApiKey: body.openaiApiKey || undefined,
          githubPat: body.githubPat || undefined,
        },
      }),
      invalidatesTags: (_result, _error, { orgId }) => [
        { type: EBaseApiCacheTags.CREDENTIALS, id: orgId },
        EBaseApiCacheTags.SESSION,
      ],
    }),
  }),
});

export const { useGetCredentialsQuery, useSaveCredentialsMutation } = credentialsApi;
