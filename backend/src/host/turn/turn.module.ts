import { CreateModule } from '@workspace/nestjs-core';
import { AgentCredentialsModule } from '../agent-credentials/agent-credentials.module';
import { GithubModule } from '../github/github.module';
import { HostTransportModule } from '../host-transport/host-transport.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TurnDispatcherService } from './turn-dispatcher.service';
import { TurnEnvBuilder } from './turn-env-builder.service';
import { TurnSpecBuilderService } from './turn-spec-builder.service';

@CreateModule({
  imports: [HostTransportModule, SandboxModule, GithubModule, AgentCredentialsModule],
  services: [TurnDispatcherService, TurnSpecBuilderService, TurnEnvBuilder],
})
export class TurnModule {}
