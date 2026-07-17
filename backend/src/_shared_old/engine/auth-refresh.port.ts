import type { SessionEngine } from '../domain';

export interface AuthRefreshSink {
  persist(
    provenance: { orgId: string; engine: SessionEngine; credentialId?: string },
    secret: string,
  ): Promise<void>;
}

export const AUTH_REFRESH_SINK = Symbol('AUTH_REFRESH_SINK');
