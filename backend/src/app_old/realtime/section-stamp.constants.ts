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
