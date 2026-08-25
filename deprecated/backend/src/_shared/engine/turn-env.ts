export interface TurnEnvContext {
  orgId: string;
  jobId: string;
}

export interface TurnEnvFragment {
  source: string;
  env: Record<string, string | null>;
  credentialsFile?: string;
}

export interface TurnEnvContributor {
  contribute(ctx: TurnEnvContext): Promise<TurnEnvFragment | null>;
}
