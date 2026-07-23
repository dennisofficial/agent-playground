import { getRealtimeClient } from '@/lib/realtime/realtime-client';
import { makeSocketListOpener, streamList } from '@workspace/pg-realtime/rtk';
import type {
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
    // Delivers RAW `agent_credentials` rows (no server-side projection) — the `plan`/`usage` fields
    // that used to be computed server-side are time-sensitive (usage windows expire), so consumers
    // derive `AgentCredentialView` on read via `buildAgentCredentialView` (see credentials-section.tsx)
    // instead of freezing a stale projection in the RTK Query cache.
    getAgentCredentials: build.query<RawAgentCredential[], string>({
      // Socket-only: the realtime feed delivers the full initial snapshot on subscribe.
      queryFn: () => ({ data: [] }),
      providesTags: (_result, _error, orgId) => [
        { type: EBaseApiCacheTags.AGENT_CREDENTIALS, id: orgId },
      ],
      onCacheEntryAdded: (orgId, api) =>
        streamList<RawAgentCredential>({
          url: 'agent_credentials',
          open: makeSocketListOpener(getRealtimeClient(), 'agent_credentials', {
            filter: { orgId },
          }),
          lifecycle: api,
        }),
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
  useRemoveAgentCredentialMutation,
} = agentCredentialsApi;
