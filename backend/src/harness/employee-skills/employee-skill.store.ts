import { EmployeeSkill as EmployeeSkillEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows } from '../memory/sql';
import type { SkillSource } from '../skills/skill.types';
import type { EmployeeSkillRecord, NewEmployeeSkill } from './employee-skill.types';

interface SkillRow {
  id: number;
  employee_id: string;
  name: string;
  description: string;
  source: SkillSource;
}

const toRecord = (r: SkillRow): EmployeeSkillRecord => ({
  id: r.id,
  employeeId: r.employee_id,
  name: r.name,
  description: r.description,
  source: r.source,
});

/**
 * The durable store for DB-controlled employee skills — the GLOBAL tier (`team_id IS NULL`), which
 * every workspace's copy of an employee loads. The provisioner unions these rows with the employee's
 * code-declared `skills`, so a skill can be added by a row here (admin API or seeder) with no code
 * change. Plain SQL (house pattern). Per-team overrides (non-null `team_id`) are deferred — the
 * engine homes are global per employee, so a per-team grant has nowhere to materialize yet.
 */
export class EmployeeSkillStore {
  constructor(private readonly repo: Repository<EmployeeSkillEntity>) {}

  private async q(sql: string, params: unknown[]): Promise<SkillRow[]> {
    return rawRows<SkillRow>(await this.repo.manager.query(sql, params));
  }

  /** Global skills granted to one employee. */
  async listForEmployee(employeeId: string): Promise<EmployeeSkillRecord[]> {
    const rows = await this.q(
      `SELECT id, employee_id, name, description, source
         FROM employee_skills
        WHERE team_id IS NULL AND employee_id = $1
        ORDER BY id`,
      [employeeId],
    );
    return rows.map(toRecord);
  }

  /** Every global skill row (all employees) — the reconcile poll diffs this to spot DB changes. */
  async listAll(): Promise<EmployeeSkillRecord[]> {
    const rows = await this.q(
      `SELECT id, employee_id, name, description, source
         FROM employee_skills
        WHERE team_id IS NULL
        ORDER BY employee_id, id`,
      [],
    );
    return rows.map(toRecord);
  }

  /** Grant a skill (global tier). Returns the new row. */
  async add(input: NewEmployeeSkill): Promise<EmployeeSkillRecord> {
    const [row] = await this.q(
      `INSERT INTO employee_skills (employee_id, team_id, name, description, source)
       VALUES ($1, NULL, $2, $3, $4::jsonb)
       RETURNING id, employee_id, name, description, source`,
      [
        input.employeeId,
        input.name,
        input.description ?? '',
        JSON.stringify(input.source),
      ],
    );
    return toRecord(row);
  }

  /** Idempotent upsert keyed by (employee_id, name) in the global tier — used by the seeder so a
   * `db:seed` re-run doesn't duplicate. (No DB unique constraint on the nullable team_id, so the
   * existence check lives here.) */
  async upsert(input: NewEmployeeSkill): Promise<EmployeeSkillRecord> {
    const existing = await this.q(
      `SELECT id, employee_id, name, description, source
         FROM employee_skills
        WHERE team_id IS NULL AND employee_id = $1 AND name = $2`,
      [input.employeeId, input.name],
    );
    if (existing.length) {
      const [row] = await this.q(
        `UPDATE employee_skills
            SET description = $2, source = $3::jsonb, updated_at = now()
          WHERE id = $1
          RETURNING id, employee_id, name, description, source`,
        [existing[0].id, input.description ?? '', JSON.stringify(input.source)],
      );
      return toRecord(row);
    }
    return this.add(input);
  }

  /** Remove a granted skill by id. Returns whether a row was deleted. */
  async remove(id: number): Promise<boolean> {
    const res = (await this.repo.manager.query(
      `DELETE FROM employee_skills WHERE id = $1 AND team_id IS NULL`,
      [id],
    )) as unknown;
    // pg returns [rows, rowCount]; the manager.query delete returns an array whose 2nd slot is count.
    return Array.isArray(res) && typeof res[1] === 'number' ? res[1] > 0 : true;
  }
}
