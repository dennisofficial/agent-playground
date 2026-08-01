import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@dltech/jwt-auth/server';
import type { ClaimsBuilder } from '@dltech/pgbase/context';
import { EOrgRole } from '@workspace/shared';
import type { AtlasClaims, AtlasPrincipal } from './atlas-claims';

@Injectable()
export class AtlasClaimsBuilder implements ClaimsBuilder<AtlasPrincipal, AtlasClaims> {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prismaService: PrismaService,
  ) {}

  /**
   * Short by design. The principal is a bearer token whose signature is only re-checked when the
   * claims are rebuilt, so this TTL is also the window in which an expired or revoked token keeps
   * working. Seconds, not minutes.
   */
  readonly ttlMs = 15_000;

  key(principal: AtlasPrincipal): string {
    return principal;
  }

  async build(principal: AtlasPrincipal): Promise<AtlasClaims> {
    const { sub } = await this.jwtService.verifyAccessToken(principal);
    if (!sub) throw new UnauthorizedException('Malformed access token');

    const memberships = await this.prismaService.organizationMember.findMany({
      where: { userId: sub },
      select: { orgId: true, role: true },
    });

    return {
      userId: sub,
      orgIds: memberships.map((m) => m.orgId),
      ownerOrgIds: memberships.filter((m) => m.role === EOrgRole.OWNER).map((m) => m.orgId),
    };
  }
}
