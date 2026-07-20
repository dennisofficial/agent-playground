import { CreateModule } from '@workspace/nestjs-core';
import { EngineTransportModule } from '../engine-transport/engine-transport.module';
import { RunnerService } from './runner.service';

@CreateModule({
  imports: [EngineTransportModule],
  providers: [RunnerService],
})
export class RunnerModule {}
