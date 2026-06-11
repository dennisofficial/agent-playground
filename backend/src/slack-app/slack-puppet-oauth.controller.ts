import { EnvService } from '@core/config/env/env.service';
import { SlackIdentityStore } from '@harness/slack-identities/slack-identity.store';
import { Controller, Get, Header, Logger, Query } from '@nestjs/common';
import { WebClient } from '@slack/web-api';

const page = (title: string, detail: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh}main{max-width:28rem;text-align:center}</style>
</head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;

interface PuppetCreds {
  clientId: string;
  clientSecret: string;
}

/**
 * The per-employee puppet install callback — one-click install of a global (unlisted-distribution)
 * puppet app into a workspace. The install URL carries the bot id in `state` (e.g. `&state=alex`);
 * this exchanges the code with THAT puppet's client id/secret (from `SLACK_PUPPET_OAUTH`, a JSON
 * map keyed by bot id) and stores the resulting per-workspace bot token in `slack_identities` under
 * `(team_id, bot_id)`. Without this, capturing each puppet × workspace token is a manual
 * `oauth.v2.access` + admin PUT.
 */
@Controller('slack/puppet')
export class SlackPuppetOauthController {
  private readonly logger = new Logger(SlackPuppetOauthController.name);

  constructor(
    private readonly identities: SlackIdentityStore,
    private readonly env: EnvService,
  ) {}

  @Get('oauth')
  @Header('content-type', 'text/html; charset=utf-8')
  async redirect(
    @Query('code') code?: string,
    @Query('state') botId?: string,
    @Query('error') error?: string,
  ): Promise<string> {
    if (error || !code || !botId) {
      return page(
        'Install cancelled',
        error === 'access_denied'
          ? 'No problem — re-run the install whenever you are ready.'
          : `Missing ${!botId ? 'puppet id (state)' : 'code'}.`,
      );
    }
    const creds = this.credsFor(botId);
    if (!creds) {
      return page(
        'Unknown puppet',
        `No OAuth credentials configured for "${botId}" — add it to SLACK_PUPPET_OAUTH.`,
      );
    }
    try {
      const oauth = await new WebClient().oauth.v2.access({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        code,
        redirect_uri: this.redirectUri(),
      });
      const teamId = oauth.team?.id;
      const token = oauth.access_token;
      if (!teamId || !token)
        throw new Error('oauth.v2.access returned no team/token');
      // Capture the bot's Slack user ID so JarvisService can recognise puppet-join events.
      const auth = await new WebClient(token).auth.test();
      await this.identities.put(teamId, botId, token, {
        slackBotUserId: auth.user_id,
      });
      this.logger.log(
        `puppet '${botId}' installed in workspace ${teamId} (bot user: ${auth.user_id})`,
      );
      return page(
        'Installed 🎉',
        `${botId} can now post and react in this workspace.`,
      );
    } catch (err) {
      this.logger.error(`puppet oauth (${botId}) failed: ${err}`);
      return page(
        'Install failed',
        'The token exchange failed — check the server logs.',
      );
    }
  }

  /** Per-puppet client id/secret from the `SLACK_PUPPET_OAUTH` JSON map (keyed by bot id). */
  private credsFor(botId: string): PuppetCreds | undefined {
    const raw = this.env.get('SLACK_PUPPET_OAUTH');
    if (!raw) return undefined;
    try {
      const map = JSON.parse(raw) as Record<string, PuppetCreds>;
      const c = map[botId];
      return c?.clientId && c?.clientSecret ? c : undefined;
    } catch (err) {
      this.logger.error(`SLACK_PUPPET_OAUTH is not valid JSON: ${err}`);
      return undefined;
    }
  }

  private redirectUri(): string | undefined {
    const base = this.env.get('GATEWAY_PUBLIC_URL');
    return base ? `${base.replace(/\/+$/, '')}/slack/puppet/oauth` : undefined;
  }
}
