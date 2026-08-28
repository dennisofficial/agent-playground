import {
  EContextSlot,
  expandSkillBody,
  resolveSubmission,
  type CommandSpec,
  type EventDraft,
} from '@dltech/atlas-core'

import { ECommandEffect, type LocalCommand } from './local-command'

export type LoadedSkill = { spec: CommandSpec; body: string }

export enum EDispatch {
  Ran = 'ran',
  Refused = 'refused',
  Send = 'send',
}

export type Dispatch =
  | { type: EDispatch.Ran }
  | { type: EDispatch.Refused; reason: string }
  | { type: EDispatch.Send; text: string; drafts: readonly EventDraft[] }

export function commandSpecs(args: {
  commands: readonly LocalCommand[]
  skills: readonly LoadedSkill[]
}): readonly CommandSpec[] {
  return [...args.commands, ...args.skills.map((skill) => skill.spec)]
}

export async function dispatchSubmission(args: {
  text: string
  commands: readonly LocalCommand[]
  skills: readonly LoadedSkill[]
}): Promise<Dispatch> {
  const submission = resolveSubmission({
    text: args.text,
    specs: commandSpecs({ commands: args.commands, skills: args.skills }),
  })

  const invoked = submission.local
  if (invoked !== null) {
    const command = args.commands.find((one) => one.name === invoked.spec.name)
    if (command === undefined) return { type: EDispatch.Send, text: args.text, drafts: [] }

    const effect = await command.run({ argumentText: invoked.argumentText })
    if (effect.type === ECommandEffect.Refused) {
      return { type: EDispatch.Refused, reason: effect.reason }
    }

    return { type: EDispatch.Ran }
  }

  const bodies = new Map(args.skills.map((skill) => [skill.spec.name, skill.body]))

  const drafts = submission.skills.flatMap((one): EventDraft[] => {
    const body = bodies.get(one.spec.name)
    if (body === undefined) return []

    return [
      {
        type: 'context-loaded',
        slot: EContextSlot.Skill,
        key: one.spec.name,
        content: expandSkillBody({ body, argumentText: one.argumentText }),
      },
    ]
  })

  return { type: EDispatch.Send, text: args.text, drafts }
}
