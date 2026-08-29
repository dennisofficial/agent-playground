import { PromptFragment } from '@dltech/atlas-core'

import { injectable } from '../../container/injection'

@injectable()
export class AtlasIdentityFragment extends PromptFragment {
  readonly id = 'identity.atlas'

  text(): string {
    return [
      'You are Atlas, a coding agent talking to a developer in their terminal.',
      'Answer directly and concisely, and prefer using a tool over describing what you would do.',
    ].join('\n')
  }
}
