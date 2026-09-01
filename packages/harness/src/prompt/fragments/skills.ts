import { renderSkillListing, type PromptContext, type SkillListingEntry } from '@dltech/atlas-core'

import { inject, injectable, portToken } from '../../container/injection'
import { SkillRegistryPort } from '../../skills/port'
import { VolatilePromptFragment } from '../volatile'

const SKILL_LISTING_BUDGET_FRACTION_OF_CONTEXT = 0.03
const CHARS_PER_TOKEN = 4
const CONTEXT_WINDOW_WHEN_THE_MODEL_IS_UNCATALOGUED = 200_000

const preamble = [
  'These skills are packaged instructions, each written for one kind of work and each more specific about it than anything you would work out yourself.',
  'When one of them covers the task in front of you, call the skill tool with its name and follow what comes back, before planning an approach of your own.',
  'Only the name and the summary are here; the instructions themselves arrive when you load one.',
].join(' ')

const budgetCharsFor = (ctx: PromptContext): number =>
  Math.floor(
    (ctx.model?.contextWindow ?? CONTEXT_WINDOW_WHEN_THE_MODEL_IS_UNCATALOGUED) *
      CHARS_PER_TOKEN *
      SKILL_LISTING_BUDGET_FRACTION_OF_CONTEXT,
  )

@injectable()
export class SkillListingFragment extends VolatilePromptFragment {
  readonly id = 'skills.listing'

  constructor(@inject(portToken(SkillRegistryPort)) private readonly skills: SkillRegistryPort) {
    super()
  }

  private entries(): readonly SkillListingEntry[] {
    return this.skills
      .all()
      .filter((skill) => skill.modelInvocable)
      .map((skill) => ({
        name: skill.spec.name,
        description: skill.frontmatter.description,
        whenToUse: skill.frontmatter.whenToUse,
      }))
  }

  override stamp(ctx: PromptContext): string {
    return this.text(ctx)
  }

  text(ctx: PromptContext): string {
    const entries = this.entries()
    if (entries.length === 0) return ''

    const listing = renderSkillListing({ entries, budgetChars: budgetCharsFor(ctx) }).trim()
    if (listing === '') return ''

    return `${preamble}\n\n${listing}`
  }
}
