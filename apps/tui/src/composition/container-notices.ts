import { EExecutionLocation } from '@dltech/atlas-core'

const whereItRuns = (location: EExecutionLocation): string =>
  location === EExecutionLocation.Host ? 'on the host' : 'in a Docker container'

export const currentLocationNotice = (location: EExecutionLocation): string =>
  `this conversation runs ${whereItRuns(location)}`

export const movedLocationNotice = (location: EExecutionLocation): string =>
  location === EExecutionLocation.Host
    ? 'this conversation runs on the host again'
    : `this conversation now runs ${whereItRuns(location)} — a read outside the project will fail from the next turn on`
