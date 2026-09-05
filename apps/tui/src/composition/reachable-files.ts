import { EExecutionLocation } from '@dltech/atlas-core'

export function reachableRootsFor(args: {
  location: EExecutionLocation
  projectDirectory: string
  mounts: readonly string[]
}): readonly string[] | undefined {
  if (args.location === EExecutionLocation.Host) return undefined
  return [args.projectDirectory, ...args.mounts]
}
