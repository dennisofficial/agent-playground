/**
 * Wire shapes for the admin portal auth API.
 *
 * IAdminUserResponse is the public projection of an AdminUser — password_hash is
 * deliberately omitted and must NEVER appear in any API response.
 */
export interface IAdminUserResponse {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: Date;
}

/** Returned by POST /auth/login, GET /auth/session, and POST /auth/refresh. */
export interface LoginResponse {
  user: IAdminUserResponse;
}

