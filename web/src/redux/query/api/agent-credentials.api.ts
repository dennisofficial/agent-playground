import { pgbase } from '@/lib/pgbase/client';
import { agentCredentialToRaw } from '@/lib/pgbase/adapters';
import { liveListEndpoint } from '@/lib/pgbase/rtk';
import type {
  AccountUsage,
  AgentCredentialView,
  ClaudeAuthorizeUrlResult,
  CodexDevicePollResult,
  CodexDeviceStartResult,
  RawAgentCredential,
} from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';

export const agentCredentialsApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getAgentCredentials: build.query<RawAgentCredential[], string>({
      ...liveListEndpoint(pgbase.AgentCredential, agentCredentialToRaw, (orgId: string) => ({
        where: { orgId },
      })),
      providesTags: (_result, _error, orgId) => [
        { type: EBaseApiCacheTags.AGENT_CREDENTIALS, id: orgId },
      ],
    }),

    startClaudeAuthorize: build.mutation<ClaudeAuthorizeUrlResult, { orgId: string }>({
      query: ({ orgId }) => ({
        url: `/orgs/${orgId}/agent-credentials/claude/authorize-url`,
        method: 'POST',
      }),
    }),
    createClaudePersonal: build.mutation<
      AgentCredentialView,
      { orgId: string; code: string; state: string }
    >({
      query: ({ orgId, code, state }) => ({
        url: `/orgs/${orgId}/agent-credentials/claude/personal`,
        method: 'POST',
        data: { code, state },
      }),
    }),
    createClaudeSetupToken: build.mutation<
      AgentCredentialView,
      { orgId: string; setupToken: string; label?: string }
    >({
      query: ({ orgId, setupToken, label }) => ({
        url: `/orgs/${orgId}/agent-credentials/claude/setup-token`,
        method: 'POST',
        data: { setupToken, label },
      }),
    }),

    startCodexDevice: build.mutation<CodexDeviceStartResult, { orgId: string }>({
      query: ({ orgId }) => ({
        url: `/orgs/${orgId}/agent-credentials/codex/device/start`,
        method: 'POST',
      }),
    }),
    pollCodexDevice: build.mutation<CodexDevicePollResult, { orgId: string; handle: string }>({
      query: ({ orgId, handle }) => ({
        url: `/orgs/${orgId}/agent-credentials/codex/device/poll`,
        method: 'POST',
        data: { handle },
      }),
    }),
    pasteCodexAuth: build.mutation<
      AgentCredentialView,
      { orgId: string; authJson: string; label?: string }
    >({
      query: ({ orgId, authJson, label }) => ({
        url: `/orgs/${orgId}/agent-credentials/codex/paste`,
        method: 'POST',
        data: { authJson, label },
      }),
    }),

    setSelectedAgentCredential: build.mutation<
      { ok: true },
      { orgId: string; credentialId: string }
    >({
      query: ({ orgId, credentialId }) => ({
        url: `/orgs/${orgId}/agent-credentials/selected`,
        method: 'PUT',
        data: { credentialId },
      }),
    }),
    refreshAgentCredentialUsage: build.mutation<AccountUsage | null, { orgId: string; id: string }>({
      query: ({ orgId, id }) => ({
        url: `/orgs/${orgId}/agent-credentials/${id}/usage`,
        method: 'GET',
      }),
    }),
    removeAgentCredential: build.mutation<{ ok: true }, { orgId: string; id: string }>({
      query: ({ orgId, id }) => ({
        url: `/orgs/${orgId}/agent-credentials/${id}`,
        method: 'DELETE',
      }),
    }),
  }),
});

export const {
  useGetAgentCredentialsQuery,
  useStartClaudeAuthorizeMutation,
  useCreateClaudePersonalMutation,
  useCreateClaudeSetupTokenMutation,
  useStartCodexDeviceMutation,
  usePollCodexDeviceMutation,
  usePasteCodexAuthMutation,
  useSetSelectedAgentCredentialMutation,
  useRefreshAgentCredentialUsageMutation,
  useRemoveAgentCredentialMutation,
} = agentCredentialsApi;
