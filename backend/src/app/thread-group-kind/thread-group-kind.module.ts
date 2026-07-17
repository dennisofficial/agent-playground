import { Global, Module } from '@nestjs/common';
import { ThreadGroupKindRegistry } from './thread-group-kind.service';

@Global()
@Module({
  providers: [ThreadGroupKindRegistry],
  exports: [ThreadGroupKindRegistry],
})
export class ThreadGroupKindModule {}
