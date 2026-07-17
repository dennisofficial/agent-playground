import { EUserRole, EUserStatus } from '@workspace/shared';
import { Column, Entity, Index, PrimaryGeneratedColumn, Repository } from 'typeorm';
import { TimestampedEntity } from '../../../_lib/database/base.entity';

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

  @Column({ type: 'enum', enum: EUserRole, default: EUserRole.OPERATOR })
  role!: EUserRole;

  @Column({ type: 'enum', enum: EUserStatus, default: EUserStatus.PENDING })
  status!: EUserStatus;
}

/** Injectable DI token / typed alias for the User repository. */
export class UserRepo extends Repository<User> {}
