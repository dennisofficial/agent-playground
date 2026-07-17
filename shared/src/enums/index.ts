/** Lifecycle state of an organization. */
export enum EOrgStatus {
  ONBOARDING = 'onboarding',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

/** A user's role within a single organization. */
export enum EOrgRole {
  OWNER = 'owner',
  MEMBER = 'member',
}

/** A user's platform-wide role. */
export enum EUserRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
}

/** Account lifecycle — new sign-ups are PENDING until an operator approves them. */
export enum EUserStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}
