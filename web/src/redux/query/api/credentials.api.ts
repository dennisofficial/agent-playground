import {
  ECredentialKey,
  type CredentialPresence,
  type SaveCredentialsResult,
} from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';

/** The settings UI's domain view of credential presence — derived from the agnostic wire. */
export interface CredentialPresenceView {
  hasAnthropic: boolean;
  hasOpenai: boolean;
  hasGithub: boolean;
  /** Anthropic key server-probe verdict — not available until the engine module; mirrors presence for now. */
  llmValidated: boolean;
  /** GitHub credential mode; the real value comes from github-app status. Defaults to 'pat'. */
  githubAuthMode: 'pat' | 'app';
}

/** The settings UI's domain write body — mapped to key-agnostic `entries[]` before it hits the wire. */
export interface SaveCredentialsBody {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  githubPat?: string;
}

function toCredentialPresenceView(present: CredentialPresence['present']): CredentialPresenceView {
  return {
    hasAnthropic: Boolean(present[ECredentialKey.ANTHROPIC_API_KEY]),
    hasOpenai: Boolean(present[ECredentialKey.OPENAI_API_KEY]),
    hasGithub: Boolean(present[ECredentialKey.GITHUB_PAT]),
    llmValidated: Boolean(present[ECredentialKey.ANTHROPIC_API_KEY]),
    githubAuthMode: 'pat',
  };
}

function toEntries(body: SaveCredentialsBody) {
  const byKey: [ECredentialKey, string | undefined][] = [
    [ECredentialKey.ANTHROPIC_API_KEY, body.anthropicApiKey],
    [ECredentialKey.OPENAI_API_KEY, body.openaiApiKey],
    [ECredentialKey.GITHUB_PAT, body.githubPat],
  ];
  // Drop empty values — the backend ignores them too (a blank field is a no-op, not a delete).
  return byKey
    .filter(([, v]) => v != null && v !== '')
    .map(([key, value]) => ({ key, value: value as string }));
}

export const credentialsApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getCredentials: build.query<CredentialPresenceView, string>({
      query: (orgId) => ({ url: `/orgs/${orgId}/credentials`, method: 'GET' }),
      transformResponse: (res: CredentialPresence) => toCredentialPresenceView(res.present),
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
        data: { entries: toEntries(body) },
      }),
      invalidatesTags: (_result, _error, { orgId }) => [
        { type: EBaseApiCacheTags.CREDENTIALS, id: orgId },
        EBaseApiCacheTags.SESSION,
      ],
    }),
  }),
});

export const { useGetCredentialsQuery, useSaveCredentialsMutation } = credentialsApi;
