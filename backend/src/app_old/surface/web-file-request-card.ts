export interface WebFileRequestCard {
  type: 'file_request_card';
  jobId: string;
  requestId: string;
  path: string;
  description: string;
  filename?: string;
  provided_at?: string;
  delivered_at?: string;
  withdrawnAt?: string;
  withdrawnReason?: string;
}

export function nextFileRequestId(existingIds: readonly string[]): string {
  const max = existingIds.reduce((m, id) => {
    const match = /^f(\d+)$/.exec(id);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return `f${max + 1}`;
}

export function webFileRequestCard(input: {
  jobId: string;
  requestId: string;
  path: string;
  description: string;
}): WebFileRequestCard {
  return {
    type: 'file_request_card',
    jobId: input.jobId,
    requestId: input.requestId,
    path: input.path,
    description: input.description,
  };
}
