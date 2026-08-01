-- The mount-mode labels were the only enum values using hyphens, which are not valid TypeScript
-- identifiers. Prisma therefore had to @map them, and a mapped enum member keeps the SCHEMA
-- IDENTIFIER as its JavaScript value while the database keeps the label — so the client returned
-- 'per_thread' for a row stored as 'per-thread'. Both are "correct" and they never match, and a
-- bare `as EMountMode` cast cannot catch it: TypeScript skips the overlap check between an enum and
-- a disjoint string union.
--
-- Renaming the labels to match the identifiers removes the divergence at its source. RENAME VALUE
-- rewrites the label in place, so stored rows keep pointing at the same member.
--
-- Conditional because the baseline now creates these labels already-correct: this migration only
-- has work to do on a database that predates the fix (the dev one), and must be a no-op on any
-- database built from 0_init.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'workspace_mounts_mode_enum' AND e.enumlabel = 'per-thread'
  ) THEN
    ALTER TYPE "workspace_mounts_mode_enum" RENAME VALUE 'per-thread' TO 'per_thread';
    ALTER TYPE "workspace_mounts_mode_enum" RENAME VALUE 'shared-ro' TO 'shared_ro';
    ALTER TYPE "workspace_mounts_mode_enum" RENAME VALUE 'shared-rw' TO 'shared_rw';
  END IF;
END $$;
