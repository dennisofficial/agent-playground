import { EmployeeMcpServer as EmployeeMcpEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows } from '../memory/sql';
import type { McpServerConfig } from '../skills/skill.types';

interface McpRow {
  id: number;
  employee_id: string;
  config: McpServerConfig;
}

/** What the admin/seeder supplies to grant an MCP server (the config carries its own `name`). */
export interface NewEmployeeMcp {
  employeeId: string;
  config: McpServerConfig;
}

export interface EmployeeMcpRecord {
  id: number;
  employeeId: string;
  config: McpServerConfig;
}

const toRecord = (r: McpRow): EmployeeMcpRecord => ({
  id: r.id,
  employeeId: r.employee_id,
  config: r.config,
});

/**
 * The durable store for DB-controlled employee MCP servers — the GLOBAL tier (`team_id IS NULL`),
 * unioned by the provisioner with each employee's code-declared `mcpServers`. Mirrors
 * {@link EmployeeSkillStore}. Plain SQL (house pattern). Per-team overrides deferred.
 */
export class EmployeeMcpStore {
  constructor(private readonly repo: Repository<EmployeeMcpEntity>) {}

  private async q(sql: string, params: unknown[]): Promise<McpRow[]> {
    return rawRows<McpRow>(await this.repo.manager.query(sql, params));
  }

  async listForEmployee(employeeId: string): Promise<EmployeeMcpRecord[]> {
    const rows = await this.q(
      `SELECT id, employee_id, config
         FROM employee_mcp_servers
        WHERE team_id IS NULL AND employee_id = $1
        ORDER BY id`,
      [employeeId],
    );
    return rows.map(toRecord);
  }

  async listAll(): Promise<EmployeeMcpRecord[]> {
    const rows = await this.q(
      `SELECT id, employee_id, config
         FROM employee_mcp_servers
        WHERE team_id IS NULL
        ORDER BY employee_id, id`,
      [],
    );
    return rows.map(toRecord);
  }

  async add(input: NewEmployeeMcp): Promise<EmployeeMcpRecord> {
    const [row] = await this.q(
      `INSERT INTO employee_mcp_servers (employee_id, team_id, name, config)
       VALUES ($1, NULL, $2, $3::jsonb)
       RETURNING id, employee_id, config`,
      [input.employeeId, input.config.name, JSON.stringify(input.config)],
    );
    return toRecord(row);
  }

  /** Idempotent upsert keyed by (employee_id, config.name) in the global tier — for the seeder. */
  async upsert(input: NewEmployeeMcp): Promise<EmployeeMcpRecord> {
    const existing = await this.q(
      `SELECT id, employee_id, config
         FROM employee_mcp_servers
        WHERE team_id IS NULL AND employee_id = $1 AND name = $2`,
      [input.employeeId, input.config.name],
    );
    if (existing.length) {
      const [row] = await this.q(
        `UPDATE employee_mcp_servers
            SET config = $2::jsonb, updated_at = now()
          WHERE id = $1
          RETURNING id, employee_id, config`,
        [existing[0].id, JSON.stringify(input.config)],
      );
      return toRecord(row);
    }
    return this.add(input);
  }

  async remove(id: number): Promise<boolean> {
    const res = (await this.repo.manager.query(
      `DELETE FROM employee_mcp_servers WHERE id = $1 AND team_id IS NULL`,
      [id],
    )) as unknown;
    return Array.isArray(res) && typeof res[1] === 'number' ? res[1] > 0 : true;
  }
}
