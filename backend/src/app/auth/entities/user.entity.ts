import { Column, Entity, Index, PrimaryGeneratedColumn, Repository } from 'typeorm';
import { TimestampedEntity } from '../../../_lib/database/base.entity';

export type UserRole = 'admin' | 'operator';
/** New sign-ups land as `pending` and must be approved before they can log in. */
export type UserStatus = 'pending' | 'active' | 'suspended';

@Entity({ name: 'users' })
export class User extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'text' })
  email!: string;

  @Column({ type: 'text' })
  passwordHash!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', default: 'operator' })
  role!: UserRole;

  @Column({ type: 'text', default: 'pending' })
  status!: UserStatus;
}

/** Injectable DI token / typed alias for the User repository. */
export class UserRepo extends Repository<User> {}
