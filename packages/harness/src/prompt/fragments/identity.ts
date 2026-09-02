import { EPromptAgent, PromptFragment, type PromptContext } from '@dltech/atlas-core'


export class AtlasIdentityFragment extends PromptFragment {
  readonly id = 'identity.atlas'

  override applies(ctx: PromptContext): boolean {
    return ctx.agent === EPromptAgent.Main
  }

  text(): string {
    return [
      'You are Atlas, a coding agent talking to a developer in their terminal.',
      'Answer directly and concisely, and prefer using a tool over describing what you would do.',
    ].join('\n')
  }
}
