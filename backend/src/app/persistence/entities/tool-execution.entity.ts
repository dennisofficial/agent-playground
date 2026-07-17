import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'tool_executions' })
export class ToolExecutionEntity extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  turn_id!: string;

  @PrimaryColumn({ type: 'uuid' })
  tool_call_id!: string;

  @Column({ type: 'text' })
  tool_name!: string;

  @Column({ type: 'jsonb' })
  reply!: Record<string, unknown>;
}
