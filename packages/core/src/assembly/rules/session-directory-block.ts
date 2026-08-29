import type { Event } from '../../events/envelope'
import { wrapInSystemReminder } from '../../context/render'
import { sessionDirectoryOf } from '../../workspace/session-directory'
import { defineRule, type Rule } from '../rule'

export function sessionDirectoryReminder(args: {
  projectDirectory: string
  sessionDirectory: string
}): string {
  return wrapInSystemReminder(
    [
      `A cd has moved the session directory to ${args.sessionDirectory}.`,
      'That is where a bash command starts, so run one without opening it with cd.',
      `Paths you pass to other tools still resolve against the project directory, ${args.projectDirectory}.`,
    ].join(' '),
  )
}

const lastEventOf = (events: readonly Event[]): Event | undefined => events[events.length - 1]

export function sessionDirectoryBlock({
  projectDirectory,
}: {
  projectDirectory: string
}): Rule {
  return defineRule({
    name: 'sessionDirectoryBlock',
    apply: (input, ctx) => {
      const sessionDirectory = sessionDirectoryOf({ events: ctx.events, projectDirectory })
      if (sessionDirectory === projectDirectory) return input

      const anchor = lastEventOf(ctx.events)
      if (anchor === undefined) return input

      return {
        system: input.system,
        messages: [
          ...input.messages,
          {
            message: {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: sessionDirectoryReminder({ projectDirectory, sessionDirectory }) },
              ],
            },
            origin: { eventId: anchor.id, seq: anchor.seq },
          },
        ],
      }
    },
  })
}
