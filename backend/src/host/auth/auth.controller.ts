import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { CurrentUser, Public } from '@dltech/jwt-auth/server';
import { SkipLogger } from '@dltech/nestjs-core';
import {
  LoginDto,
  RegisterDto,
  type AuthSession,
  type CurrentUserResponse,
} from '@workspace/shared';
import type { Request, Response } from 'express';
import type { User } from '../../_lib/database/entities/user.entity';
import { OrgService } from '../org/org.service';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly orgs: OrgService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthSession }> {
    const user = await this.auth.login(body.email, body.password, res);
    return { user };
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.OK)
  async register(@Body() body: RegisterDto): Promise<void> {
    // Always ends in a 403 (pending approval); never issues a session.
    await this.auth.register(body.email, body.password, body.name);
  }

  @Get('session')
  @SkipLogger()
  async session(@CurrentUser() user: User): Promise<CurrentUserResponse> {
    const orgs = await this.orgs.listForUser(user.id);
    return { id: user.id, email: user.email, name: user.name, orgs };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    await this.auth.refresh(req, res);
    return { ok: true };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    this.auth.clearTokens(res);
    return { ok: true };
  }
}
