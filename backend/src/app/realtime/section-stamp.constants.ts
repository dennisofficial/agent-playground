/**
 * DDL for the `jobs_stamp_section_entered` trigger — the sole writer of
 * `JobEntity.section_first_entered` (see job.entity.ts). Boot-reconciled by `SectionStampService`,
 * NOT migration-managed, so it can be re-applied idempotently on every leader promotion. Unqualified
 * relation names (`jobs`, not `app.jobs`): the physical `jobs` table lives in the connection's default
 * `public` schema, matching how the generated migrations write bare `"jobs"` and how `THREADS_MODEL`
 * in `job-realtime.model.ts` sets no schema.
 */
export const SECTION_STAMP_DDL = `
CREATE OR REPLACE FUNCTION jobs_stamp_section_entered() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (coalesce(NEW.section_first_entered, '{}'::jsonb) ? NEW.status) THEN
    NEW.section_first_entered = jsonb_set(
      coalesce(NEW.section_first_entered, '{}'::jsonb),
      ARRAY[NEW.status], to_jsonb(now()), true);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS jobs_stamp_section_entered ON jobs;
CREATE TRIGGER jobs_stamp_section_entered
  BEFORE INSERT OR UPDATE OF status ON jobs
  FOR EACH ROW
  WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION jobs_stamp_section_entered();
`;
