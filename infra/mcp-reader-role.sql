-- infra/mcp-reader-role.sql
--
-- Idempotent bootstrap of the SELECT-only `mcp_reader` Postgres role used by the standalone read-only
-- diagnostics MCP server (mcp-reader). Run ONCE on the box, against the Atlas app database, after the
-- schema has been migrated (the SELECT grant covers existing tables; ALTER DEFAULT PRIVILEGES covers
-- future ones). Re-runnable at any time — it creates the role only if missing and always re-applies the
-- grants and refreshes the password.
--
-- This is what makes decision d1 (read-only prod access) STRUCTURAL rather than a matter of app code:
-- the role handed to the reader can ONLY SELECT — never INSERT/UPDATE/DELETE or run DDL — so even a fully
-- compromised reader process cannot mutate production. There is no write role in the reader at all.
--
-- Usage (run from the box; the password comes from the reader's scoped env file, never hard-coded here):
--
--   PW="$(grep -E '^MCP_READER_PG_PASSWORD=' /srv/atlas/secrets/mcp-reader.env | cut -d= -f2-)"
--   docker exec -i atlas-postgres psql -v ON_ERROR_STOP=1 \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -v mcp_reader_password="$PW" \
--     -f - < infra/mcp-reader-role.sql
--
-- (MCP_READER_PG_USER must be `mcp_reader` and MCP_READER_PG_DB must equal $POSTGRES_DB.)

\set ON_ERROR_STOP on

-- 1. The login role. Created only if absent; the password is (re)set from the psql variable every run,
--    so this doubles as the key-rotation step for the DB credential.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
    CREATE ROLE mcp_reader LOGIN;
  END IF;
END
$$;
ALTER ROLE mcp_reader WITH LOGIN PASSWORD :'mcp_reader_password';

-- 2. Read-only grants. CONNECT is granted on whatever database this script is run against.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mcp_reader', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;

-- 3. Future tables (added by later migrations, owned by the migrating role) are SELECT-able too, without
--    re-running this script. NOTE: default privileges attach to the role that CREATES the objects — the
--    Atlas migrator runs as the owner below, so its future tables inherit this grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_reader;

-- 4. Cap any single statement so a runaway diagnostic query can't load prod Postgres (belt; the
--    atlas_query tool also sets this per-session via SET LOCAL statement_timeout).
ALTER ROLE mcp_reader SET statement_timeout = '10s';
