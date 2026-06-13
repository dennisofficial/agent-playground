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
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from './sessions/session-registry.port';
import { SessionRunnerService } from './sessions/session-runner.service';
import { ToolRegistry } from './tools/tool.registry';
import { DEFAULT_CHAT_TOOLSET } from './tools/default-toolset';
import { WorktreeService } from './worktrees/worktree.service';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';

/**
 * Proves the whole composition root assembles: every domain module's DI graph resolves against live
 * Postgres + the lazily-imported ESM SDK tokens, the tool registry discovers the full default
 * toolset, and every engine resolves. No LLM calls.
 */
describe('HarnessModule (full DI assembly, live Postgres)', () => {
  it('boots, discovers tools, and resolves all engines', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EnvModule.forRoot({
          envService: EnvService,
          validationSchema: envConfigValidation,
        }),
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
        'add_board_task',
        'add_note',
        'add_task',
        'check_session',
        'get_ticket',
        'claim_board_task',
        'close_session',
        'complete_task',
        'create_session',
        'create_worktree',
        'end_turn',
        'forget',
        'list_board',
        'list_rooms',
        'list_sessions',
        'list_tasks',
        'list_worktrees',
        'mark_pr_ready',
        'open_pr',
        'publish_worktree',
        'pull_worktree',
        'recall',
        'recent_work',
        'remember',
        'remove_worktree',
        'reply_session',
        'search_session',
        'send_message',
        'share_artifact',
        'update_board_task',
        'update_memory',
      ].sort(),
    );
    expect(tools.terminalToolNames(DEFAULT_CHAT_TOOLSET)).toEqual(
      new Set(['create_session', 'reply_session', 'end_turn']),
    );

    const engines = moduleRef.get(EngineRegistry);
    expect(engines.get(EWorkerEngineName.CLAUDE).name).toBe('claude');
    expect(engines.get(EWorkerEngineName.CODEX).name).toBe('codex');
    expect(engines.get(EWorkerEngineName.LANGGRAPH).name).toBe('langgraph');

    expect(moduleRef.get(GateService)).toBeDefined();
    expect(moduleRef.get(ChannelService)).toBeDefined();
    expect(moduleRef.get(SessionRunnerService)).toBeDefined();
    expect(moduleRef.get(WorktreeService)).toBeDefined();
    expect(moduleRef.get<SessionRegistry>(SESSION_REGISTRY)).toBeDefined();

    await moduleRef.close();
  });
});
