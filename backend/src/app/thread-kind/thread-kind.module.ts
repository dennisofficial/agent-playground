import { Global, Module } from '@nestjs/common';
import { ThreadKindRegistry } from './thread-kind.service';

@Global()
@Module({
  providers: [ThreadKindRegistry],
  exports: [ThreadKindRegistry],
})
export class ThreadKindModule {}
