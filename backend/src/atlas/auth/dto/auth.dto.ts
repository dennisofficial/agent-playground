import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/** `POST /auth/login` body. */
export class LoginDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email!: string;

  @IsString()
  password!: string;
}

/** `POST /auth/register` body. */
export class RegisterDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  password!: string;

  /** Display name (optional). */
  @IsOptional()
  @IsString()
  name?: string;
}

/**
 * The session object returned by `/auth/login` + `/auth/register` (wrapped in `{ user }`) and
 * `/auth/session` (bare). The `@workspace/auth` client maps it via `sessionToAuthState` (reads `.id`);
 * the web console reads `.email`/`.name` for the account menu.
 */
export interface AtlasSession {
  id: string;
  email: string;
  name: string | null;
}
