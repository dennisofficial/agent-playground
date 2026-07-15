/**
 * The backfill SQL for the DenseTaskOrdinals migration (1784138169645), lifted into `src` so BOTH the
 * migration (which lives outside the app's `tsc` rootDir under `backend/migrations/`) and its live-Postgres
 * integration test import the EXACT same statements — no drift between what ships and what is tested.
 *
 * Renumbers `tasks.ordinal` to a DENSE per-stage sequence (1,2,3 — the short `#N` task id post-#261) and
 * remaps the `blocked_by` arrays #261 stored in uuid space onto the target rows' new `#N`, joining through
 * the same per-stage `ROW_NUMBER` mapping and dropping any dangling uuid that no longer names a row.
 */
export const DENSE_TASK_ORDINALS_UP: readonly string[] = [
  // 1) Remap blocked_by (uuid → new #N) using the SAME per-stage ROW_NUMBER mapping the ordinal renumber
  //    uses. Order-independent vs. step 2: the new ordinal equals its rn (order preserved), so recomputing
  //    the mapping after step 2 yields the same rn. A row with an empty blocked_by produces no LATERAL rows
  //    → it's absent from `remapped` and left untouched.
  `
  WITH m AS (
    SELECT id, thread_group_id,
           ROW_NUMBER() OVER (PARTITION BY thread_group_id ORDER BY ordinal, created_at) AS rn
    FROM tasks
  ),
  remapped AS (
    SELECT t.id,
           COALESCE(
             jsonb_agg(to_jsonb(m2.rn::text) ORDER BY e.ord)
               FILTER (WHERE m2.rn IS NOT NULL),
             '[]'::jsonb
           ) AS arr
    FROM tasks t
    CROSS JOIN LATERAL jsonb_array_elements_text(t.blocked_by) WITH ORDINALITY AS e(val, ord)
    LEFT JOIN m m2 ON m2.id = e.val::uuid AND m2.thread_group_id = t.thread_group_id
    GROUP BY t.id
  )
  UPDATE tasks t
  SET blocked_by = remapped.arr
  FROM remapped
  WHERE t.id = remapped.id
  `,
  // 2) Dense-renumber ordinals per stage.
  `
  UPDATE tasks t
  SET ordinal = r.rn
  FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY thread_group_id ORDER BY ordinal, created_at) AS rn
    FROM tasks
  ) r
  WHERE t.id = r.id
  `,
];
