import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { LoginDto } from './login.dto';
import { AuthService } from './auth.service';

/**
 * Cookie-based JWT auth for the admin portal.
 * No guard on this controller — login/refresh/logout are always public;
 * session is self-verifying via the access cookie.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Exchange credentials for httpOnly access_token + refresh_token cookies. */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.login(dto.email, dto.password, res);
  }

  /** Return the current session user from the access_token cookie (no guard — service verifies). */
  @Get('session')
  session(@Req() req: Request) {
    return this.auth.getSession(req);
  }

  /** Rotate tokens: consume refresh_token cookie, issue new access + refresh cookies. */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.refresh(req, res);
  }

  /** Clear both auth cookies. */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response): void {
    this.auth.logout(res);
  }
}
