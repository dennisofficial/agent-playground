import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { Test, TestingModule } from '@nestjs/testing';
import { EnvModule } from '@workspace/nestjs-core';
import {
  EmployeeMcpServer,
  EmployeeSkill,
} from '@workspace/shared/schemas';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../../_lib/database/database.module';
import { EmployeeMcpStore } from './employee-mcp.store';
import { EmployeeSkillStore } from './employee-skill.store';
import { EmployeeToolsModule } from './employee-tools.module';

/**
 * Proves the DB-controlled grant stores against live Postgres: global-tier add/list/upsert/remove
 * for both skills and MCP servers. The provisioner's union of these with code-declared tools is
 * exercised here via the stores; the symlink/config materialization is unit-tested separately.
 */
describe('Employee tool grant stores (live Postgres)', () => {
  // Per-run employee id so parallel/aborted runs can't collide; cleaned by prefix in afterAll.
  const EMP = `int-emp-${Date.now().toString(36)}`;
  let moduleRef: TestingModule;
  let skills: EmployeeSkillStore;
  let mcp: EmployeeMcpStore;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        EnvModule.forRoot({
          envService: EnvService,
          validationSchema: envConfigValidation,
        }),
        DatabaseModule,
        EmployeeToolsModule,
      ],
    }).compile();
    await moduleRef.init();
    skills = moduleRef.get(EmployeeSkillStore);
    mcp = moduleRef.get(EmployeeMcpStore);
  });

  afterAll(async () => {
    const ds = moduleRef.get(DataSource);
    await ds
      .getRepository(EmployeeSkill)
      .createQueryBuilder()
      .delete()
      .where('employee_id = :e', { e: EMP })
      .execute();
    await ds
      .getRepository(EmployeeMcpServer)
      .createQueryBuilder()
      .delete()
      .where('employee_id = :e', { e: EMP })
      .execute();
    await moduleRef.close();
  });

  it('adds, lists, and removes a skill grant (global tier)', async () => {
    const added = await skills.add({
      employeeId: EMP,
      name: 'code-review',
      description: 'review diffs',
      source: { kind: 'local', path: 'skills/code-review' },
    });
    expect(added.id).toBeGreaterThan(0);

    const list = await skills.listForEmployee(EMP);
    expect(list).toHaveLength(1);
    expect(list[0].source).toEqual({ kind: 'local', path: 'skills/code-review' });

    expect(await skills.remove(added.id)).toBe(true);
    expect(await skills.listForEmployee(EMP)).toHaveLength(0);
    expect(await skills.remove(added.id)).toBe(false); // already gone
  });

  it('upsert is idempotent by (employee, name) and updates the source in place', async () => {
    const a = await skills.upsert({
      employeeId: EMP,
      name: 'dup',
      source: { kind: 'git', url: 'https://example.com/a.git' },
    });
    const b = await skills.upsert({
      employeeId: EMP,
      name: 'dup',
      source: { kind: 'git', url: 'https://example.com/b.git' },
    });
    expect(b.id).toBe(a.id); // same row
    const list = await skills.listForEmployee(EMP);
    expect(list).toHaveLength(1);
    expect(list[0].source).toMatchObject({ url: 'https://example.com/b.git' });
    await skills.remove(a.id);
  });

  it('adds, lists, and removes an MCP grant (global tier)', async () => {
    const added = await mcp.add({
      employeeId: EMP,
      config: {
        name: 'fs',
        transport: 'stdio',
        command: 'mcp-fs',
        args: ['--root', '.'],
      },
    });
    const list = await mcp.listForEmployee(EMP);
    expect(list).toHaveLength(1);
    expect(list[0].config).toMatchObject({ name: 'fs', transport: 'stdio' });

    expect(await mcp.remove(added.id)).toBe(true);
    expect(await mcp.listForEmployee(EMP)).toHaveLength(0);
  });
});
