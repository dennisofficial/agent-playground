import { CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * Created/updated timestamps shared by most harness entities. Postgres-native `timestamptz`
 * (the SQLite origin stored ISO TEXT; the adapters convert Date ↔ string at the boundary).
 * Entities with a single timestamp (worklog, ticket_comments) declare their own column instead.
 */
export abstract class TimestampedEntity {
  @CreateDateColumn({ type: 'timestamptz', update: false })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
