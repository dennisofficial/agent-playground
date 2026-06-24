import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { CurrentUser, Public } from '@workspace/auth/server';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto, type AtlasSession } from './dto/auth.dto';
import type { AtlasUser } from '../persistence/entities';

/**
 * `/auth/*` — email/password auth for the web console, mounted on the Atlas HTTP app and reached
 * same-origin via the web app's `/auth/*` proxy rewrite. Cookie-mode (the `@workspace/auth` web
 * client): login/register return `{ user: <session> }`; `/auth/session` returns the BARE session.
 *
 * `@UsePipes(ValidationPipe)` is bound here explicitly — the Atlas app has no global pipe, so the DTO
 * decorators would not otherwise fire. `whitelist` strips unknown props; `transform` coerces types.
 */
@Controller('auth')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AtlasSession }> {
    const user = await this.auth.login(body.email, body.password, res);
    return { user };
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.OK)
  async register(
    @Body() body: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AtlasSession }> {
    const user = await this.auth.register(body.email, body.password, body.name, res);
    return { user };
  }

  /** Guarded — 401 when no/invalid cookie, which the web client reads as "signed out". */
  @Get('session')
  session(@CurrentUser() user: AtlasUser): AtlasSession {
    return { id: user.id, email: user.email, name: user.name };
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
