import { IsEmail, IsString, MinLength } from 'class-validator';

/** `POST /auth/login` body. */
export class LoginDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email!: string;

  @IsString()
  password!: string;
}

/** `POST /auth/register` body. Name is collected by the UI but NOT wired through this phase. */
export class RegisterDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  password!: string;
}

/**
 * The session object returned by `/auth/login` (wrapped in `{ user }`) and `/auth/session` (bare). The
 * `@workspace/auth` client maps it via `sessionToAuthState` (reads `.id`); the web console additionally
 * reads `.email` for the account menu (`useCurrentUser`).
 */
export interface AtlasSession {
  id: string;
  email: string;
}
