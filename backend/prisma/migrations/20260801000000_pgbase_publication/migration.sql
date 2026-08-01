-- Prisma has no concept of a publication, so `prisma migrate` will never emit this, and pgbase
-- refuses to create it itself: `FOR ALL TABLES` needs superuser, which production databases
-- withhold from the application role. Without it the WAL leader fails at boot.
--
-- FOR ALL TABLES rather than a table list means a model added later is live automatically, with no
-- second place to remember. Unmodelled tables (_prisma_migrations) are decoded and dropped.
--
-- Never give this publication a column list: Postgres accepts the DDL and then blocks every UPDATE
-- and DELETE on any table that is also REPLICA IDENTITY FULL, which pgbase rejects at boot.
CREATE PUBLICATION pgbase FOR ALL TABLES;

-- REPLICA IDENTITY FULL buys DELETE filtering and exact eviction when a row leaves a subscriber's
-- scope; without it the router stays silent and a subscriber keeps a stale row until it reconnects.
-- Set on the tables whose tenant column is mutable or whose deletes must reach subscribers.
ALTER TABLE "jobs" REPLICA IDENTITY FULL;
ALTER TABLE "threads" REPLICA IDENTITY FULL;
ALTER TABLE "thread_groups" REPLICA IDENTITY FULL;
ALTER TABLE "thread_messages" REPLICA IDENTITY FULL;
ALTER TABLE "tasks" REPLICA IDENTITY FULL;
ALTER TABLE "inbound_messages" REPLICA IDENTITY FULL;
ALTER TABLE "repos" REPLICA IDENTITY FULL;
ALTER TABLE "agent_credentials" REPLICA IDENTITY FULL;
ALTER TABLE "organizations" REPLICA IDENTITY FULL;
ALTER TABLE "organization_members" REPLICA IDENTITY FULL;
