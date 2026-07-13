-- infra/mcp-writer-role.sql
--
-- Idempotent bootstrap of the DML-only `mcp_writer` Postgres role used by the Atlas backend to execute an
-- operator-APPROVED prod-recovery statement (the write path of the `atlas-prod` diagnostics MCP). Run ONCE
-- on the box, against the Atlas app database, AFTER the schema has been migrated (so the blanket grant
-- covers existing tables and, critically, so `prod_maintenance_write` exists for the audit-ledger REVOKE
-- below). Re-runnable at any time — it creates the role only if missing and always re-applies the grants
-- and refreshes the password.
--
-- This is the write sibling of `mcp-reader-role.sql`. It is what makes decision d4 STRUCTURAL rather than a
-- matter of app code: the role handed to the write path can ONLY INSERT/UPDATE/DELETE (plus SELECT, needed
-- to evaluate WHERE clauses) — it holds NO CREATE/ALTER/DROP of any kind, so DDL / schema changes are
-- physically impossible for it, and even a fully compromised writer process cannot alter the schema. The
-- role is used ONLY to run a statement an operator has already approved on its exact previewed text; all
-- reads and the pre-approval dry-run preview use the SELECT-only `mcp_reader` role instead.
--
-- Usage (run from the box; the password comes from the writer's scoped env, never hard-coded here):
--
--   PW="$(grep -E '^MCP_WRITER_PG_PASSWORD=' /srv/atlas/secrets/mcp-writer.env | cut -d= -f2-)"
--   docker exec -i atlas-postgres psql -v ON_ERROR_STOP=1 \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -v mcp_writer_password="$PW" \
--     -f - < infra/mcp-writer-role.sql
--
-- (MCP_WRITER_PG_USER must be `mcp_writer` and the writer connects to the SAME $POSTGRES_DB as the app.)

\set ON_ERROR_STOP on

-- 1. The login role. Created only if absent; the password is (re)set from the psql variable every run,
--    so this doubles as the key-rotation step for the DB credential.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer') THEN
    CREATE ROLE mcp_writer LOGIN;
  END IF;
END
$$;
ALTER ROLE mcp_writer WITH LOGIN PASSWORD :'mcp_writer_password';

-- 2. Connect + schema usage. CONNECT is granted on whatever database this script is run against.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mcp_writer', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO mcp_writer;

-- 3. DML grants — INSERT/UPDATE/DELETE plus SELECT (an UPDATE/DELETE needs SELECT to evaluate its WHERE).
--    There is deliberately NO CREATE/ALTER/DROP grant of any kind: DDL / schema changes are structurally
--    impossible for this role.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mcp_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mcp_writer;

-- 4. Sequence usage so INSERTs into serial/identity columns can advance their sequences.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO mcp_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO mcp_writer;

-- 5. Protect the audit ledger STRUCTURALLY. The blanket DML grant above would otherwise let an approved
--    arbitrary statement target `prod_maintenance_write` itself and rewrite its own audit trail. The ledger
--    is written only by the backend's normal `app` connection (never by mcp_writer), so revoking every
--    write on it here costs the recovery path nothing while making tamper physically impossible: an
--    mcp_writer attempt to INSERT/UPDATE/DELETE/TRUNCATE the ledger fails `permission denied`. This runs
--    AFTER the CREATE TABLE migration (see the "AFTER migrate" note in the header), so the table exists.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON prod_maintenance_write FROM mcp_writer;

-- 5b. Protect migration bookkeeping STRUCTURALLY, for the same reason. TypeORM's `migrations` table tracks
--    applied migration state and is what future `migration:run` invocations rely on; corrupting it via an
--    approved (or mistyped) DELETE/UPDATE is a direct migration/schema-integrity risk, not merely a data
--    sensitivity concern. mcp_writer never legitimately writes it, so this is unconditional.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON migrations FROM mcp_writer;

-- 6. Optional crown-jewel hardening (d4) — DEFERRED to a follow-up ticket unless the operator asks. The
--    human-approval gate is otherwise the only backstop, so an operator may additionally REVOKE write on
--    the most sensitive tables. Uncomment to apply:
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON users FROM mcp_writer;
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON org_credentials FROM mcp_writer;

-- 7. Cap any single statement so a runaway recovery write can't load prod Postgres (belt).
ALTER ROLE mcp_writer SET statement_timeout = '15s';
