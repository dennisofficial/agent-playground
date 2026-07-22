import { OCTOKIT_SDK_PROVIDER } from '@lib/esm/octokit.provider';
import { CreateModule } from '@workspace/nestjs-core';
import { OrgCredentialsModule } from '../org-credentials/credentials.module';
import { OrgModule } from '../org/org.module';
import { GitAuthEnvProvider } from './git-auth-env.provider';
import { GithubAccessAdapter } from './github-access.adapter';
import { GithubApiService } from './github-api.service';
import { GithubAppCallbackController } from './github-app-callback.controller';
import { GithubAppConnectService } from './github-app-connect.service';
import { GithubAppStateStore } from './github-app-state.store';
import { GithubAppTokenService } from './github-app-token.service';
import { GithubAppController } from './github-app.controller';
import { GithubTokenService } from './github-token.service';
import { GithubWebhookController } from './github-webhook.controller';
import { GithubWebhookService } from './github-webhook.service';

@CreateModule({
  imports: [OrgCredentialsModule, OrgModule],
  services: [GithubTokenService, GithubAccessAdapter, GitAuthEnvProvider],
  providers: [
    OCTOKIT_SDK_PROVIDER,
    GithubApiService,
    GithubAppTokenService,
    GithubAppStateStore,
    GithubAppConnectService,
    GithubWebhookService,
  ],
  controllers: [GithubAppController, GithubAppCallbackController, GithubWebhookController],
})
export class GithubModule {}
