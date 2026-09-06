import {
  EContextSlot,
  expandSkillBody,
  resolveSubmission,
  type CommandSpec,
  type EventDraft,
} from '@dltech/atlas-core'

import { mentionedFileDrafts, type FileLoader } from '../mentioned-files'
import {
  ECommandEffect,
  ECommandTiming,
  type CommandEffect,
  type LocalCommand,
} from './local-command'

export type LoadedSkill = { spec: CommandSpec; body: string }

export type QueuedSettled = {
  name: string
  text: string
  dropsQueue: boolean
  losesWaiting: boolean
  run: () => CommandEffect | Promise<CommandEffect>
}

export enum EDispatch {
  Ran = 'ran',
  Refused = 'refused',
  Queued = 'queued',
  Send = 'send',
}

export type Dispatch =
  | { type: EDispatch.Ran; notice?: string | undefined }
  | { type: EDispatch.Refused; reason: string }
  | { type: EDispatch.Queued; entry: QueuedSettled }
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
  working?: boolean | undefined
  loadFile?: FileLoader | undefined
  highlightedFiles?: ReadonlySet<string> | undefined
}): Promise<Dispatch> {
  const submission = resolveSubmission({
    text: args.text,
    specs: commandSpecs({ commands: args.commands, skills: args.skills }),
  })

  const invoked = submission.local
  if (invoked !== null) {
    const command = args.commands.find((one) => one.name === invoked.spec.name)
    if (command === undefined) return { type: EDispatch.Send, text: args.text, drafts: [] }

    if (args.working === true && command.timing === ECommandTiming.Settled) {
      return {
        type: EDispatch.Queued,
        entry: {
          name: command.name,
          text: args.text,
          dropsQueue: command.dropsQueue === true,
          losesWaiting: command.losesWaiting === true,
          run: () => command.run({ argumentText: invoked.argumentText }),
        },
      }
    }

    const effect = await command.run({ argumentText: invoked.argumentText })
    if (effect.type === ECommandEffect.Refused) {
      return { type: EDispatch.Refused, reason: effect.reason }
    }
    if (effect.type === ECommandEffect.Ran && effect.notice !== undefined) {
      return { type: EDispatch.Ran, notice: effect.notice }
    }

    return { type: EDispatch.Ran }
  }

  const bodies = new Map(args.skills.map((skill) => [skill.spec.name, skill.body]))

  const skillDrafts = submission.skills.flatMap((one): EventDraft[] => {
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

  const load = args.loadFile
  const fileDrafts =
    load === undefined
      ? []
      : await mentionedFileDrafts({ text: args.text, load, highlighted: args.highlightedFiles })

  return { type: EDispatch.Send, text: args.text, drafts: [...skillDrafts, ...fileDrafts] }
}
