import type { ValueTransformer } from 'typeorm';

/**
 * TypeORM returns `bigint` / `numeric` columns as STRINGS (to avoid JS float loss on values past
 * 2^53). Our analytics counts and per-turn costs are always well within `Number.MAX_SAFE_INTEGER`, so
 * coerce them back to `number` on read for ergonomic queries/aggregation. Null passes through.
 */
export const numberColumn: ValueTransformer = {
  to: (v: number | null | undefined) => v,
  from: (v: string | null) => (v == null ? v : Number(v)),
};
