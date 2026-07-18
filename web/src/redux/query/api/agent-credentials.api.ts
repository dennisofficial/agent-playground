import { env } from '@/lib/env';
import { streamList } from '@workspace/pg-realtime/rtk';
import type {
  AgentCredentialView,
  ClaudeAuthorizeUrlResult,
  CodexDevicePollResult,
  CodexDeviceStartResult,
} from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';
import { sseOpener } from './sse-opener';

// Resolve against the base URL via `new URL` so a trailing slash on NEXT_PUBLIC_BACKEND_URL doesn't
// produce `//orgs/…` (the SSE URL is used raw, not through axios's baseURL join, and `//orgs` 404s).
const realtimeUrl = (path: string): string => new URL(path, env.NEXT_PUBLIC_BACKEND_URL).toString();
const base = (orgId: string): string => `/orgs/${orgId}/agent-credentials`;

/**
 * Agent SDK accounts data layer. The list is **realtime**: `getAgentCredentials` seeds from REST, then
 * `streamList` keeps it live off the pg-realtime SSE feed — including per-account usage windows, which
 * update as WAL deltas when a harvest/poll writes the snapshot. Mutations therefore don't invalidate the
 * list; the feed reconciles it.
 */
export const agentCredentialsApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getAgentCredentials: build.query<AgentCredentialView[], string>({
      query: (orgId) => ({ url: base(orgId), method: 'GET' }),
      providesTags: (_result, _error, orgId) => [
        { type: EBaseApiCacheTags.AGENT_CREDENTIALS, id: orgId },
      ],
      onCacheEntryAdded: (orgId, api) =>
        streamList<AgentCredentialView>({
          url: realtimeUrl(`${base(orgId)}/realtime`),
          open: sseOpener,
          lifecycle: api,
        }),
    }),

    // ── Claude ──
    startClaudeAuthorize: build.mutation<ClaudeAuthorizeUrlResult, { orgId: string }>({
      query: ({ orgId }) => ({ url: `${base(orgId)}/claude/authorize-url`, method: 'POST' }),
    }),
    createClaudePersonal: build.mutation<
      AgentCredentialView,
      { orgId: string; code: string; state: string }
    >({
      query: ({ orgId, code, state }) => ({
        url: `${base(orgId)}/claude/personal`,
        method: 'POST',
        data: { code, state },
      }),
    }),
    createClaudeSetupToken: build.mutation<
      AgentCredentialView,
      { orgId: string; setupToken: string; label?: string }
    >({
      query: ({ orgId, setupToken, label }) => ({
        url: `${base(orgId)}/claude/setup-token`,
        method: 'POST',
        data: { setupToken, label },
      }),
    }),

    // ── Codex ──
    startCodexDevice: build.mutation<CodexDeviceStartResult, { orgId: string }>({
      query: ({ orgId }) => ({ url: `${base(orgId)}/codex/device/start`, method: 'POST' }),
    }),
    pollCodexDevice: build.mutation<CodexDevicePollResult, { orgId: string; handle: string }>({
      query: ({ orgId, handle }) => ({
        url: `${base(orgId)}/codex/device/poll`,
        method: 'POST',
        data: { handle },
      }),
    }),
    pasteCodexAuth: build.mutation<
      AgentCredentialView,
      { orgId: string; authJson: string; label?: string }
    >({
      query: ({ orgId, authJson, label }) => ({
        url: `${base(orgId)}/codex/paste`,
        method: 'POST',
        data: { authJson, label },
      }),
    }),

    // ── Selection / removal ──
    setSelectedAgentCredential: build.mutation<
      { ok: true },
      { orgId: string; credentialId: string }
    >({
      query: ({ orgId, credentialId }) => ({
        url: `${base(orgId)}/selected`,
        method: 'PUT',
        data: { credentialId },
      }),
    }),
    removeAgentCredential: build.mutation<{ ok: true }, { orgId: string; id: string }>({
      query: ({ orgId, id }) => ({ url: `${base(orgId)}/${id}`, method: 'DELETE' }),
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
