import { BaseAuthGuard, JwtService } from '@dltech/jwt-auth/server';
import { PrismaService } from '@lib/prisma/prisma.service';
import { CLS_USER } from '@lib/rls/atlas-claims';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { User } from '../../generated/prisma/client';

@Injectable()
export class AuthGuard extends BaseAuthGuard {
  constructor(
    reflector: Reflector,
    jwtService: JwtService,
    private readonly cls: ClsService,
    private readonly prismaService: PrismaService,
  ) {
    super(reflector, jwtService);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = await super.canActivate(context);
    if (this.cls.isActive()) {
      const req = context.switchToHttp().getRequest<{ user?: User | null }>();
      this.cls.set(CLS_USER, req.user ?? null);
    }
    return allowed;
  }

  async findUser(sub: string): Promise<User | null> {
    return this.prismaService.user.findUnique({ where: { id: sub } });
  }
}
