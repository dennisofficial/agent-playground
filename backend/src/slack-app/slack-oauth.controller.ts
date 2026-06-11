import { EnvService } from '@core/config/env/env.service';
import { SecretCipher } from '@harness/projects/secret-cipher';
import { Controller, Get, Header, Logger, Query } from '@nestjs/common';
import { WebClient } from '@slack/web-api';
import { TenantStore } from './tenant.store';

const page = (title: string, detail: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh}main{max-width:28rem;text-align:center}</style>
</head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;

/**
 * The OAuth install redirect — "install the app = the workspace exists". Exchanges the code and
 * upserts the workspace row (bot token encrypted at rest via SECRETS_ENCRYPTION_KEY). NO
 * provisioning: the one running process simply starts serving that team_id; Jarvis greets the
 * workspace in-channel once it's invited. Reinstall = token rotation (the ciphertext refreshes).
 */
@Controller('slack/oauth')
export class SlackOauthController {
  private readonly logger = new Logger(SlackOauthController.name);

  constructor(
    private readonly tenants: TenantStore,
    private readonly cipher: SecretCipher,
    private readonly env: EnvService,
  ) {}

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  async redirect(
    @Query('code') code?: string,
    @Query('error') error?: string,
  ): Promise<string> {
    if (error || !code) {
      return page(
        'Installation cancelled',
        error === 'access_denied'
          ? 'No problem — re-run the install whenever you are ready.'
          : `Slack returned: ${error ?? 'no code'}.`,
      );
    }

    try {
      const oauth = await new WebClient().oauth.v2.access({
        client_id: this.env.get('SLACK_CLIENT_ID') ?? '',
        client_secret: this.env.get('SLACK_CLIENT_SECRET') ?? '',
        code,
        redirect_uri: this.redirectUri(),
      });
      const teamId = oauth.team?.id;
      const botToken = oauth.access_token;
      if (!teamId || !botToken) throw new Error('oauth.v2.access returned no team/token');

      await this.tenants.upsertFromOauth({
        teamId,
        teamName: oauth.team?.name ?? teamId,
        botTokenCiphertext: this.cipher.encrypt(botToken),
        installedBy: oauth.authed_user?.id,
      });
      this.logger.log(`workspace ${teamId} (“${oauth.team?.name}”) installed`);
      return page(
        'Installed 🎉',
        'Head back to Slack and invite the app to a channel — Jarvis will take it from there.',
      );
    } catch (err) {
      this.logger.error(`oauth exchange failed: ${err}`);
      return page('Installation failed', 'The token exchange failed — check the server logs.');
    }
  }

  private redirectUri(): string | undefined {
    const base = this.env.get('GATEWAY_PUBLIC_URL');
    return base ? `${base.replace(/\/+$/, '')}/slack/oauth` : undefined;
  }
}
