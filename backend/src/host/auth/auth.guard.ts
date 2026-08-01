import { BaseAuthGuard, JwtService } from '@dltech/jwt-auth/server';
import { PrismaService } from '@lib/prisma/prisma.service';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { User } from '../../generated/prisma/client';

@Injectable()
export class AuthGuard extends BaseAuthGuard {
  constructor(
    reflector: Reflector,
    jwtService: JwtService,
    private readonly prismaService: PrismaService,
  ) {
    super(reflector, jwtService);
  }

  async findUser(sub: string): Promise<User | null> {
    return this.prismaService.user.findUnique({ where: { id: sub } });
  }
}
