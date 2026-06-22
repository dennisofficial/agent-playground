import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { Observable, filter, map } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
} from './approval-blocks';
import { AtlasWebSurface } from './atlas-web-surface';
import { parseWebApprovalMeta } from './web-approval-card';
import type { WebOutboundMessage } from './atlas-web-surface';

/** Body for `POST /web/say`. */
export interface WebSayRequest {
  channel: string;
  text: string;
  threadTs?: string;
  authorId?: string;
  authorName?: string;
  teamId?: string;
}

/** Body for `POST /web/approve`. */
export interface WebApproveRequest {
  /** The actionId from the card button: `atlas_approval:approve`, `:request_changes`, or `:deny`. */
  actionId: string;
  /** The serialised `ApprovalActionMeta` value from the button — carries jobId (+ decisionRecordId). */
  value: string;
  /** Who is ruling (the operator's id / display name). */
  ruledBy: string;
  /** Optional free-text for `request_changes` or `deny`. */
  note?: string;
}

const VALID_ACTION_IDS = new Set([APPROVE_ACTION_ID, REQUEST_CHANGES_ACTION_ID, DENY_ACTION_ID]);

/**
 * R0 — WEB SURFACE HTTP/SSE CONTROLLER. Mounts at `/web` on the Atlas HTTP app.
 *
 *  GET  /web/events?channel=<c>  — SSE stream of `WebOutboundMessage` events for a channel.
 *  POST /web/say                 — inject a human message (→ `AtlasWebSurface.receiveFromClient`).
 *  POST /web/approve             — submit an approval verdict (→ `AtlasWebSurface.receiveApprovalClick`).
 *  GET  /web/thread?channel=<c>  — REST history (the outbox for a channel, oldest-first).
 *
 * The controller carries the `blocks → web card` conversion: when `post()` is called with Block Kit
 * `blocks`, the surface stores them inline. On serialisation (SSE emit + history) this controller
 * converts any approval-card blocks into a `WebApprovalCard` payload. This keeps the conversion OUT
 * of `AtlasWebSurface.post()` (which must stay pure ChatSurface-contract) while still delivering web
 * payloads to clients.
 *
 * Approval-click decoupling: the controller calls `AtlasWebSurface.receiveApprovalClick()`, which
 * emits on `approval$`. `WebSurfaceModule` subscribes to that Subject and calls
 * `DecisionApprovalService.resolve` — the surface never imports the brain. No circular dep.
 *
 * Zero v1 imports.
 */
@Controller('web')
export class WebSurfaceController {
  private readonly logger = new Logger(WebSurfaceController.name);

  constructor(private readonly surface: AtlasWebSurface) {}

  /**
   * SSE stream — `GET /web/events?channel=<channel>`. Clients subscribe once and receive every
   * `WebOutboundMessage` for the channel as a `data:` JSON line. Filtered to the requested channel;
   * no authentication in R0 (added in a follow-up gate or middleware layer).
   *
   * Uses NestJS `@Sse` decorator which sets `Content-Type: text/event-stream` and `Transfer-Encoding:
   * chunked` automatically. The browser `EventSource` API or a `fetch` with streaming can consume it.
   */
  @Sse('events')
  events(@Query('channel') channel: string): Observable<MessageEvent> {
    if (!channel) {
      throw new BadRequestException('channel query param is required');
    }
    // Filter to the requested channel only — a missing filter would leak cross-tenant posts.
    return this.surface.outbound$.pipe(
      filter((msg) => msg.channel === channel),
      map((msg): MessageEvent => ({ data: msg })),
    );
  }

  /**
   * `POST /web/say` — inject a human message into Atlas. Returns the synthetic ts (use it as
   * `threadTs` for subsequent replies in the same thread).
   */
  @Post('say')
  say(@Body() body: WebSayRequest): { ts: string } {
    const { channel, text, threadTs, authorId, authorName, teamId } = body;
    if (!channel || !text) {
      throw new BadRequestException('channel and text are required');
    }
    const ts = this.surface.receiveFromClient(channel, text, {
      ...(threadTs ? { threadTs } : {}),
      ...(authorId ? { authorId } : {}),
      ...(authorName ? { authorName } : {}),
      ...(teamId ? { teamId } : {}),
    });
    return { ts };
  }

  /**
   * `POST /web/approve` — submit an approval verdict. The `value` carries the `ApprovalActionMeta`
   * (jobId + decisionRecordId). The surface's `approval$` subject emits; the module bridge resolves
   * the gate via `DecisionApprovalService.resolve`.
   */
  @Post('approve')
  approve(@Body() body: WebApproveRequest): { ok: boolean; jobId?: string } {
    const { actionId, value, ruledBy, note: _note } = body;
    if (!actionId || !value || !ruledBy) {
      throw new BadRequestException('actionId, value, and ruledBy are required');
    }
    if (!VALID_ACTION_IDS.has(actionId)) {
      throw new BadRequestException(`Unknown actionId: ${actionId}`);
    }
    const meta = parseWebApprovalMeta(value);
    if (!meta) {
      throw new BadRequestException('value is not a valid ApprovalActionMeta JSON');
    }
    this.surface.receiveApprovalClick(actionId, value, ruledBy);
    this.logger.log(`web approval click: action=${actionId} jobId=${meta.jobId} ruledBy=${ruledBy}`);
    return { ok: true, jobId: meta.jobId };
  }

  /**
   * `GET /web/thread?channel=<channel>[&threadTs=<ts>]` — REST history of Atlas's outbound messages
   * in a channel (or thread). Returns an array of `WebOutboundMessage`s, oldest-first, with any
   * Block Kit approval cards already converted to `WebApprovalCard` payloads.
   */
  @Get('thread')
  thread(
    @Query('channel') channel: string,
    @Query('threadTs') threadTs?: string,
  ): WebOutboundMessage[] {
    if (!channel) {
      throw new BadRequestException('channel query param is required');
    }
    return this.surface.channelMessages(channel, threadTs);
  }

  /**
   * `GET /web/ping` — liveness probe. Useful for the web client to detect whether the Atlas HTTP
   * server is up before opening the SSE stream.
   */
  @Get('ping')
  ping(): { ok: boolean; surface: string } {
    return { ok: true, surface: this.surface.name };
  }

  /**
   * `GET /web/channels` — list channels that have received at least one post (convenience for dev/test).
   */
  @Get('channels')
  channels(): { channels: string[] } {
    const seen = new Set(this.surface.outbox.map((m) => m.channel));
    return { channels: [...seen] };
  }
}

