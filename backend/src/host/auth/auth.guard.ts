import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BaseAuthGuard, JwtService } from '@workspace/auth/server';
import { User, UserRepo } from '../../_lib/database/entities/user.entity';

/**
 * Global auth guard. Verifies the `access_token` cookie (or Bearer header) and
 * resolves the signed-in user, which BaseAuthGuard attaches to `request.user`
 * for `@CurrentUser()`. Routes opt out with `@Public()`.
 */
@Injectable()
export class AuthGuard extends BaseAuthGuard {
  constructor(
    reflector: Reflector,
    jwtService: JwtService,
    private readonly users: UserRepo,
  ) {
    super(reflector, jwtService);
  }

  async findUser(sub: string): Promise<User | null> {
    return this.users.findOne({ where: { id: sub } });
  }
}
