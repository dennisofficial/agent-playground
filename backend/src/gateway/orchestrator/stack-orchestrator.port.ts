/**
 * The seam between the control plane and however tenant stacks actually run. v1 binds
 * ManualOrchestrator (env overlay + tenant DB + a printed run command); the multi-tenant deploy
 * pass replaces it with a ComposeOrchestrator that satisfies the SAME contract (see the env-
 * overlay contract in manual-orchestrator.ts — that file IS the spec the deploy pass implements).
 */
export const STACK_ORCHESTRATOR = Symbol('STACK_ORCHESTRATOR');

export interface TenantStackSpec {
  teamId: string;
  teamName: string;
  /** Decrypted ONLY at the provision seam — goes into the stack's env, never logs/responses. */
  botToken: string;
}

export interface ProvisionedStack {
  /** Where the gateway forwards this tenant's events (`http://host:port`). */
  stackBaseUrl: string;
}

export interface StackOrchestrator {
  /** IDEMPOTENT: tenant DB exists + migrated, env overlay materialized, stack reachable at the
   * returned URL (ManualOrchestrator: "reachable once the printed command runs"). */
  provision(spec: TenantStackSpec): Promise<ProvisionedStack>;
  suspend(teamId: string): Promise<void>;
  resume(teamId: string): Promise<ProvisionedStack>;
  status(teamId: string): Promise<'running' | 'stopped' | 'unknown'>;
}

/** The OAuth-redirect-facing flow (decrypt token → orchestrate → record stack URL) — shared by
 * the install hook and the `pnpm tenant:provision` CLI so both shapes stay one codepath. */
export const TENANT_PROVISIONER = Symbol('TENANT_PROVISIONER');

export interface TenantProvisioner {
  provision(teamId: string): Promise<ProvisionedStack>;
}
