import { EnvService } from '@core/config/env/env.service';
import { SecretCipher } from '@harness/projects/secret-cipher';
import {
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  Optional,
  Query,
} from '@nestjs/common';
import { WebClient } from '@slack/web-api';
import {
  TENANT_PROVISIONER,
  type TenantProvisioner,
} from './orchestrator/stack-orchestrator.port';
import { TenantStore } from './tenants/tenant.store';

const page = (title: string, detail: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh}main{max-width:28rem;text-align:center}</style>
</head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;

/**
 * The OAuth install redirect — "install the app = tenant exists". Exchanges the code, upserts the
 * tenant (bot token encrypted at rest via the gateway's SECRETS_ENCRYPTION_KEY), and kicks the
 * provisioner fire-and-forget (the user shouldn't stare at a spinner while a stack boots; Jarvis
 * greets them in-channel once it's up). Reinstall = token rotation: the ciphertext refreshes, the
 * running stack holds the old token until restarted (provisioner re-run rewrites the overlay).
 */
@Controller('slack/oauth')
export class SlackOauthController {
  private readonly logger = new Logger(SlackOauthController.name);

  constructor(
    private readonly tenants: TenantStore,
    private readonly cipher: SecretCipher,
    private readonly env: EnvService,
    @Optional()
    @Inject(TENANT_PROVISIONER)
    private readonly provisioner?: TenantProvisioner,
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
      this.logger.log(`tenant ${teamId} (“${oauth.team?.name}”) installed — provisioning`);

      if (this.provisioner) {
        void this.provisioner.provision(teamId).catch((err) => {
          this.logger.error(`auto-provision for ${teamId} failed: ${err}`);
        });
      } else {
        this.logger.warn(
          `no provisioner bound — run \`pnpm tenant:provision ${teamId}\` to bring the stack up`,
        );
      }
      return page(
        'Installed 🎉',
        'Head back to Slack and invite the app to a channel — Jarvis will take it from there.',
      );
    } catch (err) {
      this.logger.error(`oauth exchange failed: ${err}`);
      return page('Installation failed', 'The token exchange failed — check the gateway logs.');
    }
  }

  private redirectUri(): string | undefined {
    const base = this.env.get('GATEWAY_PUBLIC_URL');
    return base ? `${base.replace(/\/+$/, '')}/slack/oauth` : undefined;
  }
}
