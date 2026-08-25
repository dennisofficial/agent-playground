import { defineRule, type Rule } from '../rule'

export const MINIMAL_PREAMBLE = [
  'You are Atlas, a coding agent talking to a developer in their terminal.',
  'Answer directly and concisely. You have no tools in this session, so reason from what you are told.',
].join('\n')

export function systemPreamble(): Rule {
  return defineRule({
    name: 'systemPreamble',
    apply: (input) => ({
      system: [...input.system, { text: MINIMAL_PREAMBLE }],
      messages: input.messages,
    }),
  })
}
