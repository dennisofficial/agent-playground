import { CreateModule } from '@workspace/nestjs-core';
import { MemoryModule } from '../memory/memory.module';
import { ProposalService } from './proposal.service';

/**
 * The shared plan-proposal core (guard + CAS + outbound `present()`). A tiny module so BOTH the
 * `propose_plan` tool (ToolsModule) and the Atlas pipeline runner (SessionsModule) inject ONE
 * `ProposalService` — neither re-implements the guard or calls the presenter raw. Depends only on
 * MemoryModule (BoardStore + PlanStore); `PROPOSAL_PRESENTER` is bound `@Global` by the hosting
 * surface and injected `@Optional`, so no surface import is needed here.
 */
@CreateModule({
  imports: [MemoryModule],
  services: [ProposalService],
  exports: [ProposalService],
})
export class ProposalModule {}
