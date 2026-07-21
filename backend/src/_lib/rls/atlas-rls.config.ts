import { OrganizationMember } from '@lib/database/entities/organization-member.entity';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { RlsContextConfig } from '@workspace/nestjs-rls';
import type { RlsModuleAsyncOptions } from '@workspace/nestjs-rls/nest';
import { EOrgRole } from '@workspace/shared';
import { ClsService } from 'nestjs-cls';
import type { Repository } from 'typeorm';
import { AtlasClaims, CLS_CLAIMS, CLS_USER, EMPTY_CLAIMS } from './atlas-claims';

type Principal = { id: string } | null;

async function resolveFromMemberships(
  principal: Principal,
  members: Repository<OrganizationMember>,
): Promise<AtlasClaims> {
  if (!principal?.id) return EMPTY_CLAIMS;
  const rows = await members.find({
    where: { userId: principal.id },
    select: { orgId: true, role: true },
  });
  return {
    userId: principal.id,
    orgIds: rows.map((r) => r.orgId),
    ownerOrgIds: rows.filter((r) => r.role === EOrgRole.OWNER).map((r) => r.orgId),
  };
}

export const atlasRlsOptions: RlsModuleAsyncOptions = {
  imports: [TypeOrmModule.forFeature([OrganizationMember])],
  inject: [ClsService, getRepositoryToken(OrganizationMember)],
  useFactory: (
    cls: ClsService,
    members: Repository<OrganizationMember>,
  ): RlsContextConfig<unknown, AtlasClaims> => ({
    resolveContext: async () => {
      if (!cls.isActive()) return EMPTY_CLAIMS;
      const cached = cls.get<AtlasClaims | undefined>(CLS_CLAIMS);
      if (cached) return cached;
      const claims = await resolveFromMemberships(cls.get<Principal>(CLS_USER) ?? null, members);
      cls.set(CLS_CLAIMS, claims);
      return claims;
    },
    resolveClaims: (principal) => resolveFromMemberships((principal as Principal) ?? null, members),
  }),
};
