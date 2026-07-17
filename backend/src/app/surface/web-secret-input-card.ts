
export interface WebSecretInputCard {
  type: 'secret_input_card';
  jobId: string;
  requestId: string;
  name: string;
  path?: string;
  ephemeral?: boolean;
  deliver_to?: string;
  mcp?: {
    server: string;
    slot: 'header' | 'env';
    key: string;
  };
  description: string;
  url?: string;
  provided_at?: string;
  delivered_at?: string;
  withdrawnAt?: string;
  withdrawnReason?: string;
}

export function webSecretInputCard(input: {
  jobId: string;
  requestId: string;
  name: string;
  path?: string;
  description: string;
  url?: string;
  ephemeral?: boolean;
  deliver_to?: string;
  mcp?: { server: string; slot: 'header' | 'env'; key: string };
}): WebSecretInputCard {
  return {
    type: 'secret_input_card',
    jobId: input.jobId,
    requestId: input.requestId,
    name: input.name,
    ...(input.path ? { path: input.path } : {}),
    description: input.description,
    ...(input.url ? { url: input.url } : {}),
    ...(input.ephemeral ? { ephemeral: true } : {}),
    ...(input.deliver_to ? { deliver_to: input.deliver_to } : {}),
    ...(input.mcp ? { mcp: input.mcp } : {}),
  };
}
