import { EnvService } from '@core/config/env/env.service';

import { PrismaModule } from '@lib/prisma/prisma.module';
import { PrismaService } from '@lib/prisma/prisma.service';
import { Module, UnauthorizedException } from '@nestjs/common';
import { EnvModule } from '@dltech/nestjs-core';
import type { PgbaseRequest } from '@dltech/pgbase/context';
import { PgbaseModule as PgbaseCoreModule } from '@dltech/pgbase/nest';
import pgbaseSchema from '../../generated/pgbase';
import { AtlasClaimsBuilder } from './atlas-claims.builder';
import { AtlasClaimsModule } from './atlas-claims.module';
import type { AtlasPrincipal } from './atlas-claims';
import { atlasPolicies } from './policies';
import { ScopedDb } from './scoped-db';

/**
 * Reads the bearer credential without verifying it — verification is asynchronous and this hook is
 * not, so the token is carried through as the principal and `AtlasClaimsBuilder` checks the
 * signature before anything derived from it is trusted.
 *
 * The cookie comes first because that is how the browser authenticates. A browser WebSocket cannot
 * set request headers, so socket.io carries credentials in the handshake `auth` payload instead;
 * `credential()` covers both, which is why the header path alone would leave every socket
 * unauthenticated while HTTP kept working.
 */
function getPrincipal(pgbaseRequest: PgbaseRequest): AtlasPrincipal {
  const cookie = pgbaseRequest.headers.cookie;
  const fromCookie = cookie ? readCookie(cookie, 'access_token') : undefined;
  if (fromCookie) return fromCookie;

  const credential = pgbaseRequest.credential('authorization') ?? pgbaseRequest.auth.token;
  if (!credential) throw new UnauthorizedException('No access token');
  return credential.startsWith('Bearer ') ? credential.slice('Bearer '.length) : credential;
}

function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

@Module({
  imports: [
    PgbaseCoreModule.forRootAsync({
      imports: [EnvModule, PrismaModule, AtlasClaimsModule],
      inject: [EnvService, PrismaService, AtlasClaimsBuilder],
      useFactory: (
        envService: EnvService,
        prismaService: PrismaService,
        atlasClaimsBuilder: AtlasClaimsBuilder,
      ) => ({
        connectionString: PrismaService.connectionString(envService),
        prisma: prismaService,
        schema: pgbaseSchema,
        policies: atlasPolicies,
        claimsBuilder: atlasClaimsBuilder,
        getPrincipal,
        live: {
          slotName: 'pgbase_atlas',
          socketIoOptions: {
            cors: { origin: envService.get('FRONTEND_HOST'), credentials: true },
          },
        },
      }),
      scopedPrisma: ScopedDb,
    }),
  ],
  exports: [PgbaseCoreModule],
})
export class PgbaseModule {}
