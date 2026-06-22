import type {
  ApproveRequest,
  PipelineState,
  SayRequest,
  WebOutboundMessage,
} from './types';

/**
 * Thin typed client over the SAME-ORIGIN Atlas web surface. `next.config.ts` rewrites `/web/*` REST
 * to the Atlas HTTP app and `app/web/events/route.ts` streams the SSE — so the browser never needs
 * the backend URL and there is no CORS. No auth header today (the `/web/*` surface has none).
 */

class WebSurfaceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WebSurfaceError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/web${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new WebSurfaceError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const webClient = {
  ping: () => request<{ ok: boolean; surface: string }>('/ping'),

  channels: () => request<{ channels: string[] }>('/channels'),

  /** Whole-channel history (oldest-first). Pass no threadTs and coalesce client-side so a thread's
   *  root post — whose `ts` IS the threadTs — isn't dropped by the server's `threadTs` filter. */
  thread: (channel: string, threadTs?: string) => {
    const qs = new URLSearchParams({ channel });
    if (threadTs) qs.set('threadTs', threadTs);
    return request<WebOutboundMessage[]>(`/thread?${qs.toString()}`);
  },

  say: (body: SayRequest) =>
    request<{ ts: string }>('/say', { method: 'POST', body: JSON.stringify(body) }),

  approve: (body: ApproveRequest) =>
    request<{ ok: boolean; jobId?: string }>('/approve', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Real, but unreachable today (needs a threadId the web contract doesn't expose). Kept for the
   *  flip to `/web/threads`. */
  pipeline: (threadId: string, teamId: string) => {
    const qs = new URLSearchParams({ threadId, teamId });
    return request<PipelineState>(`/pipeline?${qs.toString()}`);
  },
};

export { WebSurfaceError };
