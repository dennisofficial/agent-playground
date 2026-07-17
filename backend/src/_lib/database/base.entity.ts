import { CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * Created/updated timestamps shared by Atlas entities. Postgres-native `timestamptz`.
 * The `CustomNamingStrategy` maps these camelCase properties to `created_at` / `updated_at`.
 * Join/child tables that need only a single timestamp declare their own column instead.
 */
export abstract class TimestampedEntity {
  @CreateDateColumn({ type: 'timestamptz', update: false })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
