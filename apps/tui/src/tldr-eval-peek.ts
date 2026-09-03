/** Peek at one span's rendered transcript. bun run src/tldr-eval-peek.ts <thread-title-substr> <anchorSeq> <throughSeq> */
import {
  atlasDatabaseUrl,
  createHarnessContainer,
  disposeAll,
  openAtlasDatabase,
  portToken,
  PrismaClientToken,
} from '@dltech/atlas-harness'
import { EventLogPort, toThreadId, transcriptOfRange } from '@dltech/atlas-core'

const [title, anchor, through] = process.argv.slice(2)

const container = createHarnessContainer()
const database = await openAtlasDatabase({ databaseUrl: atlasDatabaseUrl() })
container.register(PrismaClientToken, { useValue: database.prisma })

try {
  const thread = await database.prisma.thread.findFirst({
    where: { title: { contains: title ?? '' }, agentType: null },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, title: true },
  })
  if (!thread) throw new Error(`no thread matching ${title}`)

  const events = await container.resolve(portToken(EventLogPort)).read({ threadId: toThreadId(thread.id) })
  console.log(
    transcriptOfRange({
      events,
      fromSeq: Number(anchor),
      throughSeq: Number(through),
    }),
  )
} finally {
  await database.close()
  await disposeAll({ container })
}
