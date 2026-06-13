import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * Admin portal user.  UUID PK generated via `crypto.randomUUID()` at creation time
 * (never @PrimaryGeneratedColumn — we own the id so it survives DB restores / seeds).
 * password_hash is Argon2id via @node-rs/argon2.  email is unique so it doubles as the
 * login credential; name is display-only and nullable.
 */
@Entity({ name: 'admin_users' })
export class AdminUser extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'text' })
  email!: string;

  @Column({ type: 'text' })
  password_hash!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', default: 'admin' })
  role!: string;
}
