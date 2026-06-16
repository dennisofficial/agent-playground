import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { Test, TestingModule } from '@nestjs/testing';
import { EnvModule } from '@workspace/nestjs-core';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../../_lib/database/database.module';
import { GrantChangeListener } from './grant-change.listener';

/**
 * Proves the reactive grant path end to end against live Postgres: a write to `employee_skills` fires
 * the DB trigger → `NOTIFY employee_tools_changed` → the listener calls `reconcile(employeeId)`.
 */
describe('GrantChangeListener (live Postgres NOTIFY)', () => {
  const EMP = `int-listen-${Date.now().toString(36)}`;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let listener: GrantChangeListener;
  const reconciled: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        EnvModule.forRoot({
          envService: EnvService,
          validationSchema: envConfigValidation,
        }),
        DatabaseModule,
      ],
    }).compile();
    await moduleRef.init();
    ds = moduleRef.get(DataSource);

    const fakeProvisioner = {
      reconcile: (id: string) => {
        reconciled.push(id);
        return Promise.resolve();
      },
    } as never;
    listener = new GrantChangeListener(moduleRef.get(EnvService), fakeProvisioner);
    listener.onApplicationBootstrap();
    await listener.ready; // don't insert until the LISTEN is established
  });

  afterAll(async () => {
    await listener?.onModuleDestroy();
    await ds
      .query(`DELETE FROM employee_skills WHERE employee_id = $1`, [EMP])
      .catch(() => {});
    await moduleRef?.close();
  });

  it('reconciles the employee when a grant row is inserted', async () => {
    await ds.query(
      `INSERT INTO employee_skills (employee_id, team_id, name, description, source)
       VALUES ($1, NULL, 'x', '', '{}'::jsonb)`,
      [EMP],
    );
    await waitFor(() => reconciled.includes(EMP), 5000);
    expect(reconciled).toContain(EMP);
  });
});

/** Poll a predicate until true or timeout (LISTEN/NOTIFY delivery is async but fast). */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
