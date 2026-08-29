import type { CompiledPrompt } from '@dltech/atlas-core'

export const FIXTURE_DOCTRINE = 'You are Atlas, a coding agent talking to a developer in their terminal.'

export const fixturePrompt = (text: string = FIXTURE_DOCTRINE): CompiledPrompt => ({
  blocks: [{ text }],
  parts: [{ id: 'fixture.doctrine', text, chars: text.length }],
  skipped: [],
})
