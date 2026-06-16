import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reactive grant reconcile (replaces the 30s poll). A trigger on the employee tool-grant tables fires
 * `NOTIFY employee_tools_changed, '<employee_id>'` on every insert/update/delete, so ANY writer (the
 * admin REST, the seeder, or a direct SQL edit) wakes the harness `GrantChangeListener` with no
 * app-side publish. Hand-authored: triggers aren't entity-derived, so the generator can't emit them.
 */
export class AddEmployeeToolsNotifyTrigger1781630050629
  implements MigrationInterface
{
  name = 'AddEmployeeToolsNotifyTrigger1781630050629';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION notify_employee_tools_change() RETURNS trigger AS $$
      BEGIN
        -- JSON payload so the PgNotifyBus consumer can JSON.parse it: { "employeeId": "alex" }.
        PERFORM pg_notify(
          'employee_tools_changed',
          json_build_object('employeeId', COALESCE(NEW.employee_id, OLD.employee_id))::text
        );
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_employee_skills_notify
      AFTER INSERT OR UPDATE OR DELETE ON employee_skills
      FOR EACH ROW EXECUTE FUNCTION notify_employee_tools_change();
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_employee_mcp_servers_notify
      AFTER INSERT OR UPDATE OR DELETE ON employee_mcp_servers
      FOR EACH ROW EXECUTE FUNCTION notify_employee_tools_change();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_employee_mcp_servers_notify ON employee_mcp_servers`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_employee_skills_notify ON employee_skills`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS notify_employee_tools_change()`,
    );
  }
}
