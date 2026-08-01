-- TypeORM's own bookkeeping table, left behind by the migration to Prisma. Prisma tracks applied
-- migrations in "_prisma_migrations"; this one is read by nothing and is dropped so a rebuilt
-- database matches the schema. The migrations it recorded live in git history.
DROP TABLE IF EXISTS "migrations";
