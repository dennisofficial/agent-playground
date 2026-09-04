import {
  choiceValueOf,
  EExecutionLocation,
  executionLocationOf,
  ESettingId,
  type SettingsResolution,
} from '@dltech/atlas-core'

/** Where a conversation with no location of its own starts, as the layers settled it. */
export function defaultExecutionLocation(args: {
  settled: SettingsResolution
}): EExecutionLocation {
  return (
    executionLocationOf(
      choiceValueOf({
        resolution: args.settled,
        id: ESettingId.ExecutionLocation,
        fallback: EExecutionLocation.Host,
      }),
    ) ?? EExecutionLocation.Host
  )
}

/**
 * A location named on the command line is an override for that launch, so it outranks both the
 * default the settings hold and whatever the thread it lands on was last switched to.
 */
export function resolveExecutionLocation(args: {
  requested: string | undefined
  stored: EExecutionLocation | undefined
  settled: SettingsResolution
}): EExecutionLocation {
  const asked = executionLocationOf(args.requested)
  if (asked !== undefined) return asked
  if (args.stored !== undefined) return args.stored

  return defaultExecutionLocation({ settled: args.settled })
}

/** Whether a launch is pinned to one location, in which case the thread it opens does not get a say. */
export const executionPinned = (args: { requested: string | undefined }): boolean =>
  executionLocationOf(args.requested) !== undefined
