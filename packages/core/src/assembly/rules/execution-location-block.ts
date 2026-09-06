import { wrapInSystemReminder } from '../../context/render'
import type { ThreadId } from '../../events/ids'
import { EExecutionLocation } from '../../execution/location'
import { defineRule, type Rule } from '../rule'
import { appendedAtTail } from './tail-block'

export type ExecutionEnvironment = {
  location: EExecutionLocation
  mounts: readonly string[]
}

export type ExecutionLocationSource = (args: { threadId: ThreadId }) => ExecutionEnvironment

const surroundingsOf = (location: EExecutionLocation): string => {
  if (location === EExecutionLocation.Docker) return 'a Docker container'
  return 'a sandbox'
}

export function executionLocationNote(environment: ExecutionEnvironment): string | undefined {
  if (environment.location === EExecutionLocation.Host) return undefined

  const mounted =
    environment.mounts.length === 0
      ? 'A path outside the project is not mounted, so reading it will fail — that is the sandbox boundary, not a missing file.'
      : `Also mounted: ${environment.mounts.join(', ')}. A path outside those and the project is not mounted, so reading it will fail.`

  return wrapInSystemReminder(
    [
      `You are executing inside ${surroundingsOf(environment.location)}, not on the host.`,
      'The project directory is mounted at its usual path, so paths inside it work unchanged.',
      mounted,
      'git config --global fails here because the mounted ~/.gitconfig is read-only by design — git configuration is fixed in the sandbox launch environment, never by you editing it.',
    ].join(' '),
  )
}

export function executionLocationBlock({
  executionLocation,
}: {
  executionLocation: ExecutionLocationSource
}): Rule {
  return defineRule({
    name: 'executionLocationBlock',
    apply: (input, ctx) => {
      const note = executionLocationNote(executionLocation({ threadId: ctx.threadId }))
      if (note === undefined) return input

      return appendedAtTail({ input, ctx, text: note })
    },
  })
}
