import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'users' })
export class UserEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'text' })
  email!: string;

  @Column({ type: 'text' })
  password_hash!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', default: 'operator' })
  role!: string;
}
