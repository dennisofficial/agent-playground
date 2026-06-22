import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { BaseAuthGuard, JwtService } from '@workspace/auth/server';
import { Repository } from 'typeorm';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasUser } from '../persistence/entities';

/**
 * The global APP_GUARD for the Atlas HTTP app. Extends `@workspace/auth`'s `BaseAuthGuard` (cookie →
 * Bearer token extraction, `@Public()` / `@AuthOnly()` / `@Roles()` support) and resolves the user.
 *
 * `findUser` filters on `is_approved: true`, so an UNAPPROVED or de-approved account fails every
 * guarded request (the base guard throws `User not found` when this returns null) — the blocked-by-flag
 * gate is enforced continuously, not only at login.
 */
@Injectable()
export class AtlasAuthGuard extends BaseAuthGuard {
  constructor(
    reflector: Reflector,
    jwtService: JwtService,
    @InjectRepository(AtlasUser, ATLAS_CONNECTION)
    private readonly users: Repository<AtlasUser>,
  ) {
    super(reflector, jwtService);
  }

  async findUser(sub: string): Promise<AtlasUser | null> {
    return this.users.findOne({ where: { id: sub, is_approved: true } });
  }
}
