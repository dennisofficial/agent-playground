/**
 * The transport-agnostic inbound contract: Socket Mode (dev, single workspace) and the gateway
 * listener (tenant stacks, gateway-forwarded) both normalize into `SlackInbound` items and feed
 * the ONE router. `respond` is the transport-owned ack — Socket Mode wires the envelope's
 * `ack(body)`, the gateway mode wires the HTTP response (whose body the gateway pipes back to
 * Slack). It is idempotent: handlers may call it with a payload (view_submission validation
 * errors); the transport's post-route call is then a no-op.
 */

/** The inner Events API event (`body.event`) — the union of fields the harness reads. */
export interface SlackInboundEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  [key: string]: unknown;
}

/** A full Events API request body (`event_callback` shape — `team_id` routes multi-tenant). */
export interface SlackEventsApiBody {
  team_id?: string;
  event?: SlackInboundEvent;
  [key: string]: unknown;
}

/** An interactivity payload (block_actions / view_submission / view_closed …). */
export interface SlackInteractivityPayload {
  type: string;
  team?: { id?: string };
  user?: { id?: string; username?: string };
  trigger_id?: string;
  channel?: { id?: string; name?: string };
  actions?: Array<{
    action_id?: string;
    value?: string;
    [key: string]: unknown;
  }>;
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: {
      values?: Record<string, Record<string, { value?: string | null }>>;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** A slash-command invocation (`/metrics …`). Form-encoded over HTTP / a `slash_commands` socket
 * envelope — both normalize to this. `respond` returns the immediate reply (ephemeral by default). */
export interface SlackCommandPayload {
  command: string;
  text?: string;
  team_id?: string;
  user_id?: string;
  channel_id?: string;
  response_url?: string;
}

export type SlackInbound =
  | {
      kind: 'event';
      body: SlackEventsApiBody;
      respond: (body?: unknown) => Promise<void>;
    }
  | {
      kind: 'interactivity';
      payload: SlackInteractivityPayload;
      respond: (body?: unknown) => Promise<void>;
    }
  | {
      kind: 'command';
      command: SlackCommandPayload;
      respond: (body?: unknown) => Promise<void>;
    };

/** The router's deterministic pre-conductor interceptor slot (Jarvis). Optional — absent, the
 * router goes straight to the chat surface. Return true = consumed (never reaches the conductor
 * or the channel log). */
export const JARVIS_INTERCEPTOR = Symbol('JARVIS_INTERCEPTOR');
/** Second interceptor slot, tried AFTER Jarvis: the plan-approval cards' verdict handling
 * (`approval:*` action_ids / callback_ids — namespaced, so the two never overlap). */
export const APPROVAL_INTERCEPTOR = Symbol('APPROVAL_INTERCEPTOR');
/** Slash-command handler slot — the router dispatches `kind: 'command'` items straight here
 * (commands never reach the conductor or the chat surface). */
export const COMMAND_INTERCEPTOR = Symbol('COMMAND_INTERCEPTOR');
export interface SlackInboundInterceptor {
  maybeHandle(item: SlackInbound): Promise<boolean>;
}
