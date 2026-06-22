import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * An operator-console account (the web app's `/auth/*` users). Email/password only this phase — no
 * OAuth, no profile. Registration is OPEN but creates an UNAPPROVED account: `is_approved` defaults to
 * false so a freshly-registered user cannot log in until the flag is flipped (the "invite"). The
 * `AtlasAuthGuard.findUser` filters on `is_approved: true`, so de-approving an account also kills its
 * live sessions on the next request — not just at login.
 *
 * Lives on the Atlas datasource (`atlas_*` schema), distinct from the deleted v1 admin portal's
 * `admin_users` (which sat on the shared v1 connection this app doesn't compose).
 */
@Entity({ name: 'atlas_users' })
export class AtlasUser extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Login identifier; unique across the console. */
  @Index({ unique: true })
  @Column({ type: 'text' })
  email!: string;

  /** Argon2id hash of the password (never the plaintext). */
  @Column({ type: 'text' })
  password_hash!: string;

  /** Coarse role; only 'operator' this phase (kept for @Roles() down the line). */
  @Column({ type: 'text', default: 'operator' })
  role!: string;

  /** The blocked-by-flag gate: false until invited/approved. Login + every guarded request require it. */
  @Column({ type: 'boolean', default: false })
  is_approved!: boolean;
}
