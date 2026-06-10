/** DI tokens for the Slack SDK clients — factory-provided in SlackSurfaceModule (factory providers
 * are fine here; only decorated employee/tool classes must be plain class providers). */
export const SLACK_WEB_CLIENT = Symbol('SLACK_WEB_CLIENT');
export const SLACK_SOCKET_MODE_CLIENT = Symbol('SLACK_SOCKET_MODE_CLIENT');
