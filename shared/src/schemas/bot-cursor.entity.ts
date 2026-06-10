import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * How far a bot has consumed a surface's channel log — the durable per-bot cursor. `delivered_up_to`
 * is the next unconsumed seq (exclusive high-water mark), written back after each completed turn so
 * a restarted process resumes exactly where each bot left off instead of replaying or skipping.
 */
@Entity({ name: 'bot_cursors' })
export class BotCursor {
  @PrimaryColumn({ type: 'text' })
  bot_id!: string;

  @PrimaryColumn({ type: 'text' })
  surface_id!: string;

  // bigint → string through the pg driver; the CursorStore converts to number at the boundary.
  @Column({ type: 'bigint' })
  delivered_up_to!: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
