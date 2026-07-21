import { User, UserRepo } from '@lib/database/entities/user.entity';
import { CLS_USER } from '@lib/rls/atlas-claims';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BaseAuthGuard, JwtService } from '@workspace/auth/server';
import { ClsService } from 'nestjs-cls';

@Injectable()
export class AuthGuard extends BaseAuthGuard {
  constructor(
    reflector: Reflector,
    jwtService: JwtService,
    private readonly cls: ClsService,
    private readonly users: UserRepo,
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
    return this.users.findOne({ where: { id: sub } });
  }
}
