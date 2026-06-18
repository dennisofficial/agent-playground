import { z } from 'zod';
import { ProjectOnboardService } from '../../approvals/project-onboard.service';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

const onboardSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'The repo name to find and register (e.g. "cubix-infra") — I search the repos your GitHub token can already read.',
      ),
    url: z
      .string()
      .optional()
      .describe(
        'The exact https://github.com/<owner>/<repo> URL — use this when a name is ambiguous or the repo isn\'t under your own account.',
      ),
  })
  .refine((v) => !!(v.name || v.url), {
    message: 'Give either a name or a url.',
  });

/**
 * Self-onboard another of Dennis's GitHub repos into the workspace so it becomes referenceable — the
 * "don't make Dennis touch an admin UI" tool. Lead-only. It resolves the repo (by name against the
 * repos your default token can read, or by URL), and if your token already reads it, registers it
 * read-only on the spot (the common case — your repo, your token). When it CAN'T (no token / no
 * access / an ambiguous name), it posts a Slack card for Dennis to finish (he supplies the URL/token
 * in a modal) and wakes you to retry once it's registered.
 */
@HarnessTool()
export class OnboardProjectTool implements IHarnessTool<typeof onboardSchema> {
  readonly name = 'onboard_project';
  readonly description =
    "Register another of Dennis's GitHub repos so you can reference it — the self-service alternative to an admin UI. Give a name (I search the repos your token can read) or an exact GitHub URL. If your default token already reads it, it's registered read-only immediately and you can reference_project it. If it needs a token or the name is ambiguous, I post a card for Dennis to finish in Slack and wake you to retry — so don't re-run it in the meantime. Lead-only; registered projects are READ-ONLY references.";
  readonly schema = onboardSchema;

  constructor(
    private readonly employees: EmployeeRegistry,
    private readonly onboard: ProjectOnboardService,
  ) {}

  async execute(
    { name, url }: z.infer<typeof onboardSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    if (!this.employees.byId(id.selfAgent)?.teamLead)
      return `Onboarding projects is the team lead's call.`;

    const label = (name ?? url ?? 'it').trim();
    const outcome = await this.onboard.onboard({
      team: id.team,
      surfaceId: id.surface,
      proposedBy: id.selfAgent,
      name,
      url,
    });

    switch (outcome.status) {
      case 'registered':
        return `✅ Onboarded ${outcome.projectId} (read-only).\nRemedy: reference_project({ name: "${outcome.projectId}" }) to read it now.`;
      case 'already-registered':
        return `${outcome.projectId} is already registered in this workspace.\nRemedy: reference_project({ name: "${outcome.projectId}" }) to read it.`;
      case 'needs-input':
        return outcome.presented
          ? `Couldn't auto-register "${label}" (${outcome.reason}). I posted an onboarding card in the channel for Dennis to finish — he supplies the repo/token in a modal, and you'll be woken to retry the reference once it's registered. Don't re-run onboard_project for it meanwhile.`
          : `Couldn't auto-register "${label}" (${outcome.reason}) and there's no card surface here. Ask Dennis for the repo URL${/token/.test(outcome.reason) ? ' and a GitHub token with access' : ''}, then onboard_project({ url: "…" }).`;
      case 'ambiguous':
        return `Several repos match "${label}": ${outcome.matches.join(', ')}.\nRemedy: onboard_project({ url: "<the right one>" }) with the exact URL.`;
      case 'not-found':
        return `✗ No GitHub repo "${outcome.query}" your token can read — I can only reference GitHub repos. If it's pushed under a different owner/name, give me the URL.\nRemedy: onboard_project({ url: "https://github.com/<owner>/<repo>" }), or tell Dennis if it isn't on GitHub.`;
    }
  }
}
