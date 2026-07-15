import { Controller, Get, Header, Logger, Query } from '@nestjs/common';
import { Public } from '@workspace/auth/server';
import { EnvService } from '@core/config/env/env.service';
import { McpOAuthService } from './mcp-oauth.service';

/**
 * `GET /web/mcp/oauth/callback` — the redirect target the OAuth provider sends the operator's browser back to
 * after consent. `@Public()` (bypasses the global `AuthGuard`) because a provider redirect carries no operator
 * session; security is the unguessable HMAC-signed `state` + the per-row consent `nonce` verified in
 * {@link McpOAuthService.completeAuthorization}. It is intentionally NOT under `/orgs/:orgId` — the signed state
 * carries the target identity, so one fixed redirect_uri serves every org (what DCR registered).
 *
 * The redirect_uri base is `BACKEND_HOST` (dev `http://localhost:4002`, prod `https://api.byatlas.io`);
 * in prod the console lives on a DIFFERENT origin (`FRONTEND_HOST`), so the returned page `postMessage`s that
 * origin explicitly (not `*`) before closing the popup, and the console also re-polls on focus.
 */
@Public()
@Controller('web/mcp/oauth')
export class McpOAuthCallbackController {
  private readonly logger = new Logger(McpOAuthCallbackController.name);

  constructor(
    private readonly oauth: McpOAuthService,
    private readonly env: EnvService,
  ) {}

  @Get('callback')
  @Header('content-type', 'text/html; charset=utf-8')
  async callback(
    @Query('state') state?: string,
    @Query('code') code?: string,
    @Query('error') error?: string,
    @Query('error_description') errorDescription?: string,
  ): Promise<string> {
    if (error) {
      this.logger.warn(
        `oauth callback error=${error} desc=${errorDescription ?? ''}`,
      );
      return this.page(false, errorDescription || error);
    }
    if (!state || !code) return this.page(false, 'missing state or code');
    try {
      const { name } = await this.oauth.completeAuthorization(state, code);
      this.logger.log(`oauth callback connected name=${name}`);
      return this.page(true, name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`oauth callback failed: ${message}`);
      return this.page(false, message);
    }
  }

  /** A minimal self-closing page that notifies the (cross-origin in prod) console opener, then closes. */
  private page(ok: boolean, detail: string): string {
    const frontend = JSON.stringify(this.env.get('FRONTEND_HOST'));
    const title = ok ? 'Connected' : 'Authorization failed';
    const body = ok
      ? `Connected <strong>${escapeHtml(detail)}</strong>. You can close this window.`
      : `Authorization failed: ${escapeHtml(detail)}. You can close this window.`;
    // postMessage to the console origin (not '*') so it can refetch the server list; then close the popup.
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;padding:2rem;color:#222">
<p>${body}</p>
<script>
  try { if (window.opener) window.opener.postMessage({ type: 'atlas-mcp-oauth', ok: ${ok ? 'true' : 'false'} }, ${frontend}); } catch (e) {}
  setTimeout(function () { window.close(); }, 800);
</script>
</body></html>`;
  }
}

/** Minimal HTML-escape for the small dynamic bits we echo back (server name / provider error text). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
