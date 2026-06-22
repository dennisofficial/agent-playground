/** DI tokens for the Slack SDK clients Atlas's surface binds — provided as factory providers off
 * EnvService in `SurfaceModule`, faked in specs. Kept as symbols so the adapter never constructs SDK
 * clients itself (testability + a single env-read site). */
export const ATLAS_SLACK_WEB_CLIENT = Symbol('ATLAS_SLACK_WEB_CLIENT');
export const ATLAS_SLACK_SOCKET_CLIENT = Symbol('ATLAS_SLACK_SOCKET_CLIENT');
/** Builds a per-workspace Web client from a bot token (so the surface posts AS each tenant). */
export const ATLAS_SLACK_WEB_CLIENT_FACTORY = Symbol('ATLAS_SLACK_WEB_CLIENT_FACTORY');

/** The minimal Web API surface the adapter uses — declared structurally so a spec can pass a fake
 * without the real `@slack/web-api` types. */
export interface SlackWebClientLike {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
      blocks?: unknown[];
    }): Promise<{ ts?: string; ok?: boolean }>;
    /** Repaint a posted message (e.g. the approval card after a verdict). */
    update(args: {
      channel: string;
      ts: string;
      text?: string;
      blocks?: unknown[];
    }): Promise<unknown>;
  };
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
  /** Open a modal (the secret-collection / onboarding modals) from a `trigger_id`. */
  views: {
    open(args: { trigger_id: string; view: unknown }): Promise<unknown>;
  };
  auth: {
    test(): Promise<{ user_id?: string; team_id?: string; user?: string }>;
  };
}

/** A factory that builds a workspace-scoped Web client from its bot token. */
export type SlackWebClientFactory = (token: string) => SlackWebClientLike;

/** The minimal Socket Mode surface the adapter uses (event subscription + lifecycle). */
export interface SlackSocketClientLike {
  on(event: string, listener: (envelope: unknown) => void): void;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}
