/**
 * Auth API contract (frontend ⇄ backend). Request DTOs are class-validator classes
 * (validated by the backend's ValidationPipe); response shapes are interfaces. A user's
 * password hash is never part of any of them.
 */
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import type { OrgSummary } from './org.dto';

// ── Requests ──

export class LoginDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email!: string;

  @IsString()
  password!: string;
}

export class RegisterDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  password!: string;

  @IsOptional()
  @IsString()
  name?: string;
}

// ── Responses ──

/** Minimal signed-in identity, returned as `{ user }` by login / register / refresh. */
export interface AuthSession {
  id: string;
  email: string;
  name: string | null;
}

/** Returned by `GET /auth/session` — the signed-in user plus the orgs they belong to. */
export interface CurrentUserResponse extends AuthSession {
  orgs: OrgSummary[];
}

/** Envelope returned by `POST /auth/login`, `/register`, and `/refresh`. */
export interface LoginResponse {
  user: AuthSession;
}
