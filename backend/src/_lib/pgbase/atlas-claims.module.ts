import { PrismaModule } from '@lib/prisma/prisma.module';
import { Module } from '@nestjs/common';
import { JwtModule } from '@dltech/jwt-auth/server';
import { AtlasClaimsBuilder } from './atlas-claims.builder';

/**
 * Exists so `PgbaseModule.forRootAsync` can inject the claims builder: the dynamic module resolves
 * its factory against its own `imports`, not against whatever module declares it.
 */
@Module({
  imports: [PrismaModule, JwtModule],
  providers: [AtlasClaimsBuilder],
  exports: [AtlasClaimsBuilder],
})
export class AtlasClaimsModule {}
