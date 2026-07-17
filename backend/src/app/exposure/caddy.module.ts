import { Global, Module } from '@nestjs/common';
import { CaddyAdminClient } from './caddy-admin.client';

@Global()
@Module({
  providers: [CaddyAdminClient],
  exports: [CaddyAdminClient],
})
export class CaddyModule {}
