import { CreateModule } from '@dltech/nestjs-core';
import { AgentCredentialsModule } from '../agent-credentials/agent-credentials.module';
import { GithubModule } from '../github/github.module';
import { HostTransportModule } from '../host-transport/host-transport.module';
import { InboundMessageModule } from '../inbound-message/inbound-message.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TurnDispatcherService } from './turn-dispatcher.service';
import { TurnEnvBuilder } from './turn-env-builder.service';
import { TurnSpecBuilderService } from './turn-spec-builder.service';
import { TurnTranscriptService } from './turn-transcript.service';

@CreateModule({
  imports: [
    HostTransportModule,
    SandboxModule,
    GithubModule,
    AgentCredentialsModule,
    InboundMessageModule,
  ],
  services: [TurnDispatcherService, TurnSpecBuilderService, TurnEnvBuilder, TurnTranscriptService],
})
export class TurnModule {}
