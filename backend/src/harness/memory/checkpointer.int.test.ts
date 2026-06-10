import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { createCheckpointer, pgConnString } from './checkpointer';

const connString = pgConnString({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

describe('Working-memory checkpointer (PostgresSaver, live Postgres)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [],
    });
    await ds.initialize();
  });
  afterAll(async () => {
    await ds?.destroy();
  });

  it('setup() creates the LangGraph checkpoint tables and a read works', async () => {
    const saver = await createCheckpointer(connString);

    const tables: { tablename: string }[] = await ds.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'checkpoint%'`,
    );
    expect(tables.map((t) => t.tablename)).toContain('checkpoints');

    // A read on a non-existent thread returns undefined (proves connect + schema + read path).
    const tuple = await saver.getTuple({
      configurable: { thread_id: 'does-not-exist', checkpoint_ns: '' },
    });
    expect(tuple).toBeUndefined();
  });
});
