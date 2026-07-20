import type { ResolveClaims } from '@workspace/nestjs-rls';
import { rlsGuard } from '@workspace/nestjs-rls/pg-realtime';
import type { ModelConfig, Row } from '@workspace/pg-realtime';
import type {
  EAgentCredentialKind,
  EAgentCredentialStatus,
  EAgentProvider,
} from '@workspace/shared';
import { AgentCredential } from '../../_lib/database/entities/agent-credential.entity';
import { projectAgentCredentialView } from './agent-credential.view';

/**
 * The `agentCredentials` realtime model — streams each account's metadata + usage windows to the web.
 * `mapRow` projects the WAL/snapshot row to the {@link AgentCredentialView} wire shape (same projection
 * as the REST seed) and CRUCIALLY drops `material_enc` — token material never reaches the SSE feed. Keeps
 * `orgId` for the guard scope. Contributed via `PgRealtimeModule.forFeature(...)`.
 */
export function buildAgentCredentialsRealtimeModel(resolveClaims: ResolveClaims): ModelConfig {
  return {
    table: 'agent_credentials',
    name: 'agentCredentials',
    primaryKey: 'id',
    guard: rlsGuard(AgentCredential, resolveClaims),
    mapRow: (raw: Row): Row => ({
      ...projectAgentCredentialView({
        id: raw.id as string,
        provider: raw.provider as EAgentProvider,
        kind: raw.kind as EAgentCredentialKind,
        label: raw.label as string,
        accountEmail: (raw.account_email as string | null) ?? null,
        subscriptionType: (raw.subscription_type as string | null) ?? null,
        status: raw.status as EAgentCredentialStatus,
        selected: raw.selected as boolean,
        expiresAt: (raw.expires_at as Date | null) ?? null,
        usageSnapshot: (raw.usage_snapshot as never) ?? null,
        createdAt: raw.created_at as Date,
      }),
      orgId: raw.org_id, // kept for the guard scope; material_enc is intentionally omitted
    }),
  };
}
