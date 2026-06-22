import { env } from "@/lib/env";

/**
 * SSE proxy for the Atlas web surface.
 *
 * `GET /web/events?channel=<c>` is owned by this route handler (not the `next.config.ts` rewrite) so
 * we can pipe the upstream `text/event-stream` body straight through WITHOUT buffering — Next's REST
 * rewrites can buffer a streaming response, which would freeze the live transcript. We hand the
 * upstream `ReadableStream` back verbatim and forward the client's abort signal so a closed tab tears
 * down the upstream connection.
 *
 * Same-origin: the browser opens `new EventSource('/web/events?channel=…')`; the backend URL
 * (`ATLAS_HTTP_URL`) never reaches the client.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const channel = searchParams.get("channel");
  if (!channel) {
    return new Response("channel query param is required", { status: 400 });
  }

  const upstream = `${env.ATLAS_HTTP_URL}/web/events?channel=${encodeURIComponent(channel)}`;

  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: { accept: "text/event-stream" },
      // Forward client disconnects upstream so the Atlas SSE subscription is released.
      signal: request.signal,
      // @ts-expect-error — Node fetch streaming flag; harmless where unsupported.
      duplex: "half",
    });
  } catch {
    return new Response("Atlas web surface unreachable", { status: 502 });
  }

  if (!res.ok || !res.body) {
    return new Response("Atlas web surface error", { status: 502 });
  }

  return new Response(res.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
