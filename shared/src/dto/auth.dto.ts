/**
 * Wire shapes for the admin portal auth API.
 *
 * AdminUserView is the public projection of an AdminUser — password_hash is
 * deliberately omitted and must NEVER appear in any API response.
 */
export interface AdminUserView {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: Date;
}

/** Returned by POST /auth/login, GET /auth/session, and POST /auth/refresh. */
export interface LoginResponse {
  user: AdminUserView;
}

/**
 * Preferred alias for AdminUserView — use this name going forward.
 * AdminUserView is kept for backwards-compat with existing backend references.
 */
export type IAdminUserResponse = AdminUserView;
