export const DENSE_TASK_ORDINALS_UP: readonly string[] = [
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
