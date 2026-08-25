import { CreateModule } from '@dltech/nestjs-core';
import { OrgModule } from '../org/org.module';
import { AgentAuthEnvProvider } from './agent-auth-env.provider';
import { AgentAuthRefreshSink } from './agent-auth-refresh.sink';
import { AgentCredentialKeepaliveService } from './agent-credential-keepalive.service';
import { AgentCredentialRefreshService } from './agent-credential-refresh.service';
import { AgentCredentialResolver } from './agent-credential-resolver.service';
import { AgentCredentialViewModule } from './agent-credential-view.module';
import { AgentCredentialService } from './agent-credential.service';
import { AgentCredentialsController } from './agent-credentials.controller';
import { ClaudeOAuthClient } from './oauth/claude-oauth.client';
import { CodexAuthService } from './oauth/codex-auth.service';
import { CodexOAuthClient } from './oauth/codex-oauth.client';
import { MaterialFreshnessService } from './oauth/material-freshness.service';
import { OAuthDeviceStore } from './oauth/oauth-device.store';
import { OAuthPkceStore } from './oauth/oauth-pkce.store';
import { AgentUsageService } from './usage/agent-usage.service';
import { UsageParseService } from './usage/usage-parse.service';

@CreateModule({
  imports: [OrgModule, AgentCredentialViewModule],
  services: [
    AgentCredentialService,
    AgentCredentialResolver,
    AgentAuthRefreshSink,
    AgentAuthEnvProvider,
    AgentUsageService,
  ],
  providers: [
    AgentCredentialRefreshService,
    AgentCredentialKeepaliveService,
    UsageParseService,
    ClaudeOAuthClient,
    CodexOAuthClient,
    CodexAuthService,
    MaterialFreshnessService,
    OAuthPkceStore,
    OAuthDeviceStore,
  ],
  controllers: [AgentCredentialsController],
})
export class AgentCredentialsModule {}
