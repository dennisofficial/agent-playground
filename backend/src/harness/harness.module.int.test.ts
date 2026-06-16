import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { Test } from '@nestjs/testing';
import { EnvModule } from '@workspace/nestjs-core';
import { DatabaseModule } from '../_lib/database/database.module';
import { EsmModule } from '../_lib/esm/esm.module';
import { ChannelService } from './channel/channel.service';
import { EmployeeRegistry } from './employees/employee.registry';
import { EngineRegistry } from './engines/engine.registry';
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
    const boundNames = bound.map((t) => t.name);
    expect(boundNames.slice().sort()).toEqual(
      [
        'add_board_task',
        'add_note',
        'add_session_note',
        'add_task',
        'check_session',
        'get_ticket',
        'claim_board_task',
        'close_session',
        'complete_task',
        'create_session',
        'create_worktree',
        'forget',
        'investigate',
        'list_board',
        'list_rooms',
        'list_session_notes',
        'list_sessions',
        'list_tasks',
        'list_worktrees',
        'mark_pr_ready',
        'publish_worktree',
        'pull_worktree',
        'recall_facts',
        'recent_work',
        'refresh_worktree',
        'remember',
        'remove_worktree',
        'reply_session',
        'resolve_session_note',
        'search_conversation_history',
        'search_session',
        'send_message',
        'share_artifact',
        'submit_for_review',
        'submit_plan',
        'update_board_task',
        'update_memory',
      ].sort(),
    );

    // Atlas (the single orchestrator) resolves the default chat toolset PLUS its lead-only +
    // orchestrator tools — including the pipeline dispatch/enqueue tools bound at the cutover.
    const atlas = moduleRef.get(EmployeeRegistry).byId('atlas');
    expect(atlas).toBeDefined();
    const atlasNames = tools
      .toStructuredTools(atlas!.tools!)
      .map((t) => t.name)
      .sort();
    expect(atlasNames).toEqual(
      [
        ...boundNames,
        'open_pr',
        'list_pull_requests',
        'approve_plan',
        'propose_plan',
        'open_standup',
        'close_standup',
        'dispatch_pipeline',
        'enqueue_finding',
      ].sort(),
    );

    const engines = moduleRef.get(EngineRegistry);
    expect(engines.get(EWorkerEngineName.CLAUDE).name).toBe('claude');
    expect(engines.get(EWorkerEngineName.CODEX).name).toBe('codex');
    expect(engines.get(EWorkerEngineName.LANGGRAPH).name).toBe('langgraph');

    expect(moduleRef.get(ChannelService)).toBeDefined();
    expect(moduleRef.get(SessionRunnerService)).toBeDefined();
    expect(moduleRef.get(WorktreeService)).toBeDefined();
    expect(moduleRef.get<SessionRegistry>(SESSION_REGISTRY)).toBeDefined();

    await moduleRef.close();
  });
});
