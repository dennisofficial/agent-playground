import { PrismaModule } from '@lib/prisma/prisma.module';
import { Module } from '@nestjs/common';
import { AtlasClaimsBuilder } from './atlas-claims.builder';

/**
 * Exists so `PgbaseModule.forRootAsync` can inject the claims builder: the dynamic module resolves
 * its factory against its own `imports`, not against whatever module declares it.
 */
@Module({
  // JwtService is not imported here: AuthModule registers JwtModule with isGlobal, and importing
  // it bare would re-register it WITHOUT its options, shadowing the configured instance.
  imports: [PrismaModule],
  providers: [AtlasClaimsBuilder],
  exports: [AtlasClaimsBuilder],
})
export class AtlasClaimsModule {}
