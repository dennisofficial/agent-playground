import { User, UserRepo } from '@lib/database/entities/user.entity';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@workspace/auth/server';
import type { Socket } from 'socket.io';

@Injectable()
export class RealtimeAuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly userRepo: UserRepo,
  ) {}

  async authenticate(handshake: Socket['handshake']): Promise<User> {
    const token = this.extractToken(handshake);
    if (!token) throw new Error('No authentication token provided');

    const { sub } = await this.jwtService.verifyAccessToken(token);
    if (!sub) throw new Error('Malformed access token');

    const user = await this.userRepo.findOne({ where: { id: sub } });
    if (!user) throw new Error('User not found');

    return user;
  }

  private extractToken(handshake: Socket['handshake']): string | null {
    const cookieHeader = handshake.headers.cookie;
    const cookieToken = cookieHeader ? this.readCookie(cookieHeader, 'access_token') : null;
    if (cookieToken) return cookieToken;

    const authToken = (handshake.auth as { token?: unknown } | undefined)?.token;
    return typeof authToken === 'string' ? authToken : null;
  }

  private readCookie(header: string, name: string): string | null {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== name) continue;
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    return null;
  }
}
