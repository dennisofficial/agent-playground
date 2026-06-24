import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * An operator-console account (the web app's `/auth/*` users). Email/password + display name.
 * Registration is OPEN and immediately usable — a fresh account signs in and then creates or joins an
 * organization (`atlas_organization_members`). No approval gate.
 *
 * Lives on the Atlas datasource (`atlas_*` schema).
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

  /** Display name (as entered at signup). */
  @Column({ type: 'text', nullable: true })
  name!: string | null;

  /** Coarse role; 'operator' default (kept for @Roles() down the line). */
  @Column({ type: 'text', default: 'operator' })
  role!: string;
}
