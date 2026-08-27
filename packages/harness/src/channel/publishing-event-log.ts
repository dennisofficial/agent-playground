import type { EventLogPort } from '@dltech/atlas-core'

import type { DeltaChannel } from './delta-channel'

export function withDeltaPublishing(args: { log: EventLogPort; channel: DeltaChannel }): EventLogPort {
  return {
    async append(appendArgs) {
      const events = await args.log.append(appendArgs)
      args.channel.publisherFor({ threadId: appendArgs.threadId }).settleAppend({ events })
      return events
    },

    read: (readArgs) => args.log.read(readArgs),
    head: (headArgs) => args.log.head(headArgs),
    readOwn: (readArgs) => args.log.readOwn(readArgs),
  }
}
