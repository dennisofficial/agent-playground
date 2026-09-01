import { PromptFragment, type PromptContext } from '@dltech/atlas-core'

export abstract class VolatilePromptFragment extends PromptFragment {
  abstract stamp(ctx: PromptContext): string
}

export const isVolatilePromptFragment = (
  fragment: PromptFragment,
): fragment is VolatilePromptFragment => fragment instanceof VolatilePromptFragment
