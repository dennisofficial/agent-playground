import { TimestampedEntity } from '@lib/database/base.entity';
import { EUserRole, EUserStatus } from '@workspace/shared';
import { Column, Entity, Index, PrimaryGeneratedColumn, Repository } from 'typeorm';

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

export class UserRepo extends Repository<User> {}
