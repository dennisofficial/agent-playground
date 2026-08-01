-- The mount-mode labels were the only enum values in the schema using hyphens, which are not valid
-- TypeScript identifiers. Prisma therefore had to @map them, and a mapped enum member keeps the
-- SCHEMA IDENTIFIER as its JavaScript value while the database keeps the label — so the client
-- returned 'per_thread' for a row stored as 'per-thread'. Both are "correct" and they never match,
-- and a bare `as EMountMode` cast cannot catch it because TypeScript does not check assertions
-- between an enum and a disjoint string union.
--
-- Renaming the labels to match the identifiers removes the divergence at its source rather than
-- translating between the two forever. RENAME VALUE rewrites the label in place; stored rows keep
-- pointing at the same enum member.
ALTER TYPE "workspace_mounts_mode_enum" RENAME VALUE 'per-thread' TO 'per_thread';
ALTER TYPE "workspace_mounts_mode_enum" RENAME VALUE 'shared-ro' TO 'shared_ro';
ALTER TYPE "workspace_mounts_mode_enum" RENAME VALUE 'shared-rw' TO 'shared_rw';
