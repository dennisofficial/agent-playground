import { EnvService } from '@core/config/env/env.service';
import { Controller, Get, Header, Logger, Query } from '@nestjs/common';
import { Public } from '@workspace/auth/server';
import { McpOAuthService } from './mcp-oauth.service';

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
      this.logger.warn(`oauth callback error=${error} desc=${errorDescription ?? ''}`);
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

  private page(ok: boolean, detail: string): string {
    const frontend = JSON.stringify(this.env.get('FRONTEND_HOST'));
    const title = ok ? 'Connected' : 'Authorization failed';
    const body = ok
      ? `Connected <strong>${escapeHtml(detail)}</strong>. You can close this window.`
      : `Authorization failed: ${escapeHtml(detail)}. You can close this window.`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;padding:2rem;color:#222">
<p>${body}</p>
<script>
  try { if (window.opener) window.opener.postMessage({ type: 'atlas-mcp-oauth', ok: ${ok ? 'true' : 'false'} }, ${frontend}); } catch (e) {}
  setTimeout(function () { window.close(); }, 800);
</script>
</body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
