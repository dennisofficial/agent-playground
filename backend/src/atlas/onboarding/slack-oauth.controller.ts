import { EnvService } from '@core/config/env/env.service';
import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { WebClient } from '@slack/web-api';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { SlackInstallationStore } from '../surface';

/** Bot scopes Atlas requests — chat + read history + reactions + the lifecycle/mention events. */
const SCOPES = [
  'chat:write',
  'channels:read',
  'groups:read',
  'channels:history',
  'groups:history',
  'reactions:write',
  'app_mentions:read',
].join(',');

/** State validity window (ms). */
const STATE_TTL_MS = 10 * 60_000;

/**
 * The hand-rolled Slack OAuth install flow (no `@slack/oauth` dep) — the self-service "Add to Slack"
 * path so each workspace's bot token is captured automatically (no admin panel / token pasting). Mounted
 * on the Atlas HTTP app. Inert (501) unless `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` are set.
 *
 * `GET /slack/install` → redirect to Slack's consent screen with a signed `state`.
 * `GET /slack/oauth_redirect` → verify state, exchange the code via `oauth.v2.access`, store the
 * per-workspace bot token (encrypted) keyed by team_id.
 */
@Controller('slack')
export class SlackOAuthController {
  private readonly logger = new Logger(SlackOAuthController.name);

  constructor(
    private readonly env: EnvService,
    private readonly installs: SlackInstallationStore,
  ) {}

  private clientId(): string | undefined {
    return this.env.get('SLACK_CLIENT_ID');
  }
  private clientSecret(): string | undefined {
    return this.env.get('SLACK_CLIENT_SECRET');
  }
  private redirectUri(): string {
    const base = this.env.get('GATEWAY_PUBLIC_URL') ?? 'http://localhost:4002';
    return `${base.replace(/\/$/, '')}/slack/oauth_redirect`;
  }
  private stateSecret(): string {
    return this.env.get('SLACK_SIGNING_SECRET') ?? this.env.get('SECRETS_ENCRYPTION_KEY') ?? 'atlas-oauth';
  }

  @Get('install')
  install(@Res() res: Response): void {
    const clientId = this.clientId();
    if (!clientId || !this.clientSecret()) {
      res.status(501).send('Slack OAuth not configured (set SLACK_CLIENT_ID / SLACK_CLIENT_SECRET).');
      return;
    }
    const url =
      `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(this.redirectUri())}` +
      `&state=${encodeURIComponent(this.makeState())}`;
    res.redirect(url);
  }

  @Get('oauth_redirect')
  async oauthRedirect(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const clientId = this.clientId();
    const clientSecret = this.clientSecret();
    if (!clientId || !clientSecret) {
      res.status(501).send('Slack OAuth not configured.');
      return;
    }
    if (!code || !this.verifyState(state)) {
      res.status(400).send('Invalid or expired install link — start again at /slack/install.');
      return;
    }
    try {
      const result = (await new WebClient().oauth.v2.access({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: this.redirectUri(),
      })) as {
        access_token?: string;
        bot_user_id?: string;
        scope?: string;
        team?: { id?: string; name?: string };
      };
      const teamId = result.team?.id;
      const botToken = result.access_token;
      if (!teamId || !botToken) {
        res.status(502).send('Slack did not return a bot token.');
        return;
      }
      await this.installs.upsert({
        teamId,
        botToken,
        ...(result.bot_user_id ? { botUserId: result.bot_user_id } : {}),
        ...(result.scope ? { scopes: result.scope } : {}),
        ...(result.team?.name ? { teamName: result.team.name } : {}),
      });
      this.logger.log(`installed to team=${teamId} (${result.team?.name ?? '?'})`);
      res.send('✅ Atlas installed. Add it to a channel to finish setup, then close this tab.');
    } catch (err) {
      this.logger.error(`oauth exchange failed: ${err}`);
      res.status(502).send('Install failed during token exchange — please retry.');
    }
  }

  /** A signed, time-boxed CSRF state token (`<ts>.<hmac>`). */
  private makeState(): string {
    const ts = Date.now().toString();
    const sig = createHmac('sha256', this.stateSecret()).update(ts).digest('hex');
    return `${ts}.${sig}`;
  }

  private verifyState(state: string | undefined): boolean {
    if (!state) return false;
    const [ts, sig] = state.split('.');
    if (!ts || !sig) return false;
    const expected = createHmac('sha256', this.stateSecret()).update(ts).digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    return Date.now() - Number(ts) < STATE_TTL_MS;
  }
}
