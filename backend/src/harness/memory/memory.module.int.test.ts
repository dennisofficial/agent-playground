import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { EnvModule } from '@workspace/nestjs-core';
import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../../_lib/database/database.module';
import { CHECKPOINTER, MemoryModule } from './memory.module';
import { SemanticMemory } from './semantic-memory';
import { TaskStore } from './task-store';
import { WorklogStore } from './worklog-store';

/**
 * Proves the harness DI composition root assembles against the live Postgres: the memory ports resolve
 * from the container (over real TypeORM repos), and the async checkpointer provider runs `.setup()` at
 * module init. No OpenAI call (TaskStore.addTask doesn't embed).
 */
describe('MemoryModule (NestJS DI, live Postgres)', () => {
  let app: TestingModule;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      imports: [
        EnvModule.forRoot({
          envService: EnvService,
          validationSchema: envConfigValidation,
        }),
        DatabaseModule,
        MemoryModule,
      ],
    }).compile();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('resolves the memory ports and the checkpointer from DI', async () => {
    expect(app.get(SemanticMemory)).toBeInstanceOf(SemanticMemory);
    expect(app.get(WorklogStore)).toBeInstanceOf(WorklogStore);
    expect(app.get(CHECKPOINTER)).toBeDefined(); // async provider resolved → PostgresSaver.setup() ran

    // The DI-provided TaskStore writes through the real connection (no embedding).
    const tasks = app.get(TaskStore);
    await tasks['repo'].query('TRUNCATE tasks RESTART IDENTITY');
    const created = await tasks.addTask({
      team: 'di',
      project: 'di',
      description: 'di wired',
      owner: 'alex',
    });
    expect(created?.description).toBe('di wired');
  });
});
