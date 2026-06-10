import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

/**
 * Working memory — the LangGraph checkpointer, shared by the chat graph and the langgraph worker engine
 * so a conversation's (or a job's) message context survives a restart. Each graph keeps its own timeline
 * via its `thread_id`; the saver namespaces by it, so one store backs both.
 *
 * Ported from playground/src/memory/checkpointer.ts: `SqliteSaver(checkpoints.db)` → Postgres
 * `PostgresSaver` (same `BaseCheckpointSaver` interface). `.setup()` creates the checkpoint tables once
 * (they live alongside the TypeORM tables but are managed by LangGraph, not the migrations).
 */
export interface PostgresConn {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

export function pgConnString(c: PostgresConn): string {
  const user = encodeURIComponent(c.user ?? '');
  const auth = c.password ? `${user}:${encodeURIComponent(c.password)}` : user;
  return `postgresql://${auth}@${c.host ?? 'localhost'}:${c.port ?? 5432}/${c.database ?? ''}`;
}

/** Build the checkpointer and run its one-time table setup. Call once (the MemoryModule, at bootstrap). */
export async function createCheckpointer(connString: string): Promise<PostgresSaver> {
  const saver = PostgresSaver.fromConnString(connString);
  await saver.setup();
  return saver;
}
