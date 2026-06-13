import { z } from 'zod';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { TeamSettingsStore } from '../../memory/team-settings-store';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * The standup switch — lead-only. While open, the execute gate refuses every flip team-wide
 * (approved or not): a standup plans and approves the backlog as a TRANSACTION, and nothing runs
 * until the lead closes it. The pre-close conflict review (reading every approved ticket's plans
 * for contradictions) is the lead's protocol, not the tool's — the tool stays mechanical.
 */

const emptySchema = z.object({});

@HarnessTool()
export class OpenStandupTool implements IHarnessTool<typeof emptySchema> {
  readonly name = 'open_standup';
  readonly description =
    'Open the standup (team lead only): mechanically pauses ALL execute flips team-wide — running sessions finish their current turn, but nothing new starts. Open it when Dennis calls the planning sitting; plan, review, and propose inside it; close_standup is the all-clear.';
  readonly schema = emptySchema;

  constructor(
    private readonly settings: TeamSettingsStore,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute(
    _args: z.infer<typeof emptySchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    if (!this.employees.byId(ctx.identity.selfAgent)?.teamLead)
      return `Opening the standup is the team lead's call.`;
    await this.settings.setStandupOpen(ctx.identity.team, true);
    return `Standup OPEN — execute flips are paused team-wide (in-flight turns finish, nothing new starts). Plan, review, propose; close_standup starts execution.`;
  }
}

@HarnessTool()
export class CloseStandupTool implements IHarnessTool<typeof emptySchema> {
  readonly name = 'close_standup';
  readonly description =
    "Close the standup (team lead only) — the all-clear: approved tickets may start executing. Do your conflict pass FIRST: read every approved ticket's attached plans (get_ticket) and settle contradictions with Dennis before closing.";
  readonly schema = emptySchema;

  constructor(
    private readonly settings: TeamSettingsStore,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute(
    _args: z.infer<typeof emptySchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    if (!this.employees.byId(ctx.identity.selfAgent)?.teamLead)
      return `Closing the standup is the team lead's call.`;
    await this.settings.setStandupOpen(ctx.identity.team, false);
    return `Standup CLOSED — approved work may start; assignees can flip their approved tickets' sessions to execute. Post the all-clear.`;
  }
}
