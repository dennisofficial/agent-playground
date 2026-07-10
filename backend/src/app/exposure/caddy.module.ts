import { Global, Module } from '@nestjs/common';
import { CaddyAdminClient } from './caddy-admin.client';

/**
 * The Caddy admin seam — a single @Global LEAF provider so `SandboxManager` (to unbridge/route-delete on
 * teardown) and `ExposureService` (to publish routes) inject the same client without an import edge. Imports
 * nothing sandbox-side: it depends only on `EnvService` (globally provided), so it can be imported ahead of
 * the sandbox layer with no cycle.
 */
@Global()
@Module({
  providers: [CaddyAdminClient],
  exports: [CaddyAdminClient],
})
export class CaddyModule {}
