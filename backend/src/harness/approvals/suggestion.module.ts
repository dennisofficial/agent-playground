import { CreateModule } from '@workspace/nestjs-core';
import { MemoryModule } from '../memory/memory.module';
import { SuggestionService } from './suggestion.service';

/**
 * The shared task-suggestion core (capture + outbound `present()`). A tiny module — the twin of
 * `ProposalModule` — so the `suggest_task` tool (ToolsModule) and any future caller inject ONE
 * `SuggestionService`. Depends only on MemoryModule (BoardStore); `TASK_SUGGESTION_PRESENTER` is
 * bound `@Global` by the hosting surface and injected `@Optional`, so no surface import is needed.
 */
@CreateModule({
  imports: [MemoryModule],
  services: [SuggestionService],
  exports: [SuggestionService],
})
export class SuggestionModule {}
