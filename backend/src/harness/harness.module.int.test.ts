import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { Test } from '@nestjs/testing';
import { EnvModule } from '@workspace/nestjs-core';
import { DatabaseModule } from '../_lib/database/database.module';
import { EsmModule } from '../_lib/esm/esm.module';
import { ChannelService } from './channel/channel.service';
import { EngineRegistry } from './engines/engine.registry';
import { GateService } from './gate/gate.service';
import { HarnessModule } from './harness.module';
import { JOB_REGISTRY, type JobRegistry } from './jobs/job-registry.port';
import { WorkerService } from './jobs/worker.service';
import { ToolRegistry } from './tools/tool.registry';
import { DEFAULT_CHAT_TOOLSET } from './tools/default-toolset';

/**
 * Proves the whole composition root assembles: every domain module's DI graph resolves against live
 * Postgres + the lazily-imported ESM SDK tokens, the tool registry discovers the full default
 * toolset, and every engine resolves. No LLM calls.
 */
describe('HarnessModule (full DI assembly, live Postgres)', () => {
  it('boots, discovers tools, and resolves all engines', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EnvModule.forRoot({ envService: EnvService, validationSchema: envConfigValidation }),
        DatabaseModule,
        EsmModule,
        HarnessModule,
      ],
    }).compile();
    await moduleRef.init();

    const tools = moduleRef.get(ToolRegistry);
    const bound = tools.toStructuredTools(DEFAULT_CHAT_TOOLSET);
    expect(bound.map((t) => t.name).sort()).toEqual(
      [
        'add_task',
        'cancel_job',
        'check_job',
        'complete_task',
        'continue_work',
        'dispatch_job',
        'end_turn',
        'forget',
        'list_tasks',
        'recall',
        'recent_work',
        'remember',
        'update_memory',
      ].sort(),
    );
    expect(tools.terminalToolNames(DEFAULT_CHAT_TOOLSET)).toEqual(new Set(['dispatch_job', 'end_turn']));

    const engines = moduleRef.get(EngineRegistry);
    expect(engines.get('claude').name).toBe('claude');
    expect(engines.get('codex').name).toBe('codex');
    expect(engines.get('langgraph').name).toBe('langgraph');

    expect(moduleRef.get(GateService)).toBeDefined();
    expect(moduleRef.get(ChannelService)).toBeDefined();
    expect(moduleRef.get(WorkerService)).toBeDefined();
    expect(moduleRef.get<JobRegistry>(JOB_REGISTRY)).toBeDefined();

    await moduleRef.close();
  });
});
