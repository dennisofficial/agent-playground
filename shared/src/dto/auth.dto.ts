/**
 * Auth API contract (frontend ⇄ backend). Request DTOs are class-validator classes
 * (validated by the backend's ValidationPipe); response shapes are interfaces. A user's
 * password hash is never part of any of them.
 */
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import type { OrgSummary } from './org.dto';

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

export interface AuthSession {
  id: string;
  email: string;
  name: string | null;
}

export interface CurrentUserResponse extends AuthSession {
  orgs: OrgSummary[];
}

export interface LoginResponse {
  user: AuthSession;
}
