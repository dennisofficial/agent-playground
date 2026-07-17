import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { RunnableLambda, RunnableSequence, type Runnable } from '@langchain/core/runnables';
import { z } from 'zod';
import { fence, fenceOrNone } from '../prompt-fence';

export type SkillNudgeSelection = { name: string; reason: string };

export type SkillNudgeSelectorInput = {
  context: string;
  skills: { name: string; description: string }[];
  orgId?: string;
};

export type SkillNudgeSelector = {
  select(input: SkillNudgeSelectorInput): Promise<SkillNudgeSelection[]>;
};

export const SKILL_NUDGE_SELECTOR = Symbol('SKILL_NUDGE_SELECTOR');

export namespace SelectSkillNudgeChain {
  export type Input = {
    context: string;
    skills: { name: string; description: string }[];
  };

  export const Schema = z.object({
    relevant: z.array(
      z.object({
        name: z.string(),
        reason: z.string().describe('One short line explaining why the skill directly applies.'),
      }),
    ),
  });
  export type Output = z.infer<typeof Schema>;

  export const MODEL = 'claude-haiku-4-5-20251001';

  export const SYSTEM = [
    'You select which of the AVAILABLE SKILLS are *directly* relevant to the described build work. Return',
    'only skills whose guidance would materially help THIS thread; return an empty list if none clearly',
    'apply. Be precise — do NOT return a skill just because it is tangentially related (e.g. a NestJS',
    'backend skill is NOT relevant to a pure frontend/CSS thread). `name` MUST be copied exactly from the',
    'provided list.',
  ].join('\n');

  const renderSkills = (skills: Input['skills']): string =>
    skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');

  const renderUser = (i: Input): string =>
    [
      fenceOrNone('available_skills', renderSkills(i.skills)),
      fence('thread_context', i.context),
    ].join('\n\n');

  export const build = (llm: BaseChatModel): Runnable<Input, Output> =>
    RunnableSequence.from<Input, Output>([
      RunnableLambda.from((i: Input) => ({ input: renderUser(i) })),
      ChatPromptTemplate.fromMessages([
        new SystemMessage(SYSTEM),
        HumanMessagePromptTemplate.fromTemplate('{input}'),
      ]),
      llm.withStructuredOutput(Schema, { name: 'select_skills' }),
    ]).withConfig({ runName: 'Select Skill Nudge' });
}

export class AnthropicSkillNudgeSelector implements SkillNudgeSelector {
  private readonly chains = new Map<
    string,
    Runnable<SelectSkillNudgeChain.Input, SelectSkillNudgeChain.Output>
  >();

  constructor(
    private readonly apiKey: (orgId?: string) => Promise<string | undefined>,
    private readonly chainFactory: (
      llm: BaseChatModel,
    ) => Runnable<
      SelectSkillNudgeChain.Input,
      SelectSkillNudgeChain.Output
    > = SelectSkillNudgeChain.build,
  ) {}

  private async chain(
    orgId?: string,
  ): Promise<Runnable<SelectSkillNudgeChain.Input, SelectSkillNudgeChain.Output> | undefined> {
    const key = await this.apiKey(orgId);
    if (!key) return undefined;
    let c = this.chains.get(key);
    if (!c) {
      c = this.chainFactory(
        new ChatAnthropic({
          apiKey: key,
          model: SelectSkillNudgeChain.MODEL,
          maxTokens: 512,
          temperature: 0,
        }),
      );
      this.chains.set(key, c);
    }
    return c;
  }

  async select(input: SkillNudgeSelectorInput): Promise<SkillNudgeSelection[]> {
    const chain = await this.chain(input.orgId);
    if (!chain) return [];
    try {
      const out = await chain.invoke({
        context: input.context,
        skills: input.skills,
      });
      const knownNames = new Set(input.skills.map((s) => s.name));
      return out.relevant
        .filter((r) => knownNames.has(r.name))
        .map((r) => ({ name: r.name, reason: oneLineReason(r.reason) }));
    } catch {
      return [];
    }
  }
}

function oneLineReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, ' ').trim();
  return (normalized || 'directly relevant').slice(0, 200);
}
