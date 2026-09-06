/**
 * Eval harness for the tl;dr footer prompt. Samples real completed turns from the live store
 * (read-only), generates a footer for each with the pinned model, and grades it with a judge
 * against the rubric below. Run from apps/tui:
 *
 *   bun run src/tldr-eval.ts [--limit 12] [--threads 25]
 *
 * Tune by editing TLDR_INSTRUCTION in packages/harness/src/model/tldr.ts and re-running.
 * Record the final prompt and pass rate in .scratch/tldr-footer/ before shipping.
 */
import { generateText, type LanguageModel } from 'ai'

import {
  CredentialPort,
  EMessageOrigin,
  EventLogPort,
  saidBy,
  toThreadId,
  transcriptOfRange,
  type Event,
} from '@dltech/atlas-core'
import {
  atlasDatabaseUrl,
  createAnthropicOauthModel,
  createHarnessContainer,
  createSecurityKeychainReader,
  disposeAll,
  KeychainReaderToken,
  openAtlasDatabase,
  portToken,
  PrismaClientToken,
  tldrFor,
} from '@dltech/atlas-harness'

const argAfter = (flag: string, fallback: number): number => {
  const at = process.argv.indexOf(flag)
  const value = at === -1 ? undefined : process.argv[at + 1]
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const LIMIT = argAfter('--limit', 12)
const THREADS = argAfter('--threads', 25)

const JUDGE_INSTRUCTION = [
  'You grade the tl;dr footer of one turn of a coding session between Operator and Atlas.',
  'You are given the transcript of the turn and the footer written for it.',
  'Pass it only when all four hold:',
  '1. faithful — every path, symbol, command and outcome the footer names appears in the transcript,',
  '   and nothing it reports as done was merely planned or proposed;',
  "2. names the main outcome — what became of what the operator's latest message asked for.",
  '   A tl;dr omits by definition; leaving out secondary sub-tasks is not a failure;',
  '3. short — one or two lines, no preamble;',
  '4. honest about loose ends — if the turn ended waiting on something, the footer says so.',
  '   Ending by presenting a plan or question to the operator counts as waiting on the operator;',
  '5. the status matches the ending — "done" only when the ask is fully answered and nothing',
  '   remains, "waiting" only when background work is the sole thing outstanding, and',
  '   "needs-operator" whenever the ending is ambiguous, mixed, or invites review — it is the',
  '   default, so never fail a footer for choosing it on a mixed ending.',
  'Do not demand restatement of the operator\u2019s ask: a footer that says what was done and what is',
  'pending answers it implicitly. Judge facts, not emphasis — a claim that matches the transcript',
  'is faithful even where you would have phrased the loose ends differently.',
  'Reply with JSON alone: {"pass": true|false, "note": "one sentence"}.',
].join(' ')

type Span = { threadTitle: string; events: readonly Event[]; anchorSeq: number; throughSeq: number }

function spansOf({
  title,
  events,
  completedRuns,
}: {
  title: string
  events: readonly Event[]
  completedRuns: ReadonlySet<string>
}): Span[] {
  const lastSeqOfRun = new Map<string, number>()
  for (const event of events) {
    const held = lastSeqOfRun.get(event.runId)
    if (held === undefined || event.seq > held) lastSeqOfRun.set(event.runId, event.seq)
  }

  const spans: Span[] = []
  for (const [runId, throughSeq] of lastSeqOfRun) {
    if (!completedRuns.has(runId)) continue

    const anchor = events.findLast(
      (event) =>
        event.type === 'user-said' &&
        saidBy(event) === EMessageOrigin.Operator &&
        event.seq <= throughSeq,
    )
    if (anchor === undefined) continue

    const span = events.filter((event) => event.seq >= anchor.seq && event.seq <= throughSeq)
    const said = span
      .filter((event) => event.type === 'assistant-said')
      .flatMap((event) => (event.type === 'assistant-said' ? event.parts : []))
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    const tools = span.filter((event) => event.type === 'tool-called').length
    if (said.trim().length < 200 && tools === 0) continue

    spans.push({ threadTitle: title, events, anchorSeq: anchor.seq, throughSeq })
  }

  return spans
}

type Verdict = { pass: boolean; note: string }

async function judge(args: {
  model: LanguageModel
  span: Span
  footer: string
  status: string
}): Promise<Verdict> {
  const transcript = transcriptOfRange({
    events: args.span.events,
    fromSeq: args.span.anchorSeq,
    throughSeq: args.span.throughSeq,
    payloadLimit: 4_000,
  }).slice(-60_000)

  try {
    const graded = await generateText({
      model: args.model,
      system: JUDGE_INSTRUCTION,
      prompt: `<transcript>\n${transcript}\n</transcript>\n\n<footer status="${args.status}">\n${args.footer}\n</footer>`,
      maxOutputTokens: 200,
    })
    const parsed: unknown = JSON.parse(graded.text.trim().replace(/^```json\s*|\s*```$/g, ''))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pass' in parsed &&
      typeof parsed.pass === 'boolean'
    ) {
      return { pass: parsed.pass, note: 'note' in parsed ? String(parsed.note) : '' }
    }
    return { pass: false, note: 'judge returned unparseable verdict' }
  } catch (error) {
    return { pass: false, note: `judge failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function main(): Promise<void> {
  const container = createHarnessContainer()
  container.register(KeychainReaderToken, { useValue: createSecurityKeychainReader() })
  const database = await openAtlasDatabase({ databaseUrl: atlasDatabaseUrl() })
  container.register(PrismaClientToken, { useValue: database.prisma })

  try {
    const log = container.resolve(portToken(EventLogPort))
    const model = createAnthropicOauthModel({
      credentials: container.resolve(portToken(CredentialPort)),
      modelId: 'claude-haiku-4-5-20251001',
    })

    const threads: { id: string; title: string | null }[] = await database.prisma.thread.findMany({
      where: { agentType: null },
      orderBy: { updatedAt: 'desc' },
      take: THREADS,
      select: { id: true, title: true },
    })

    const spans: Span[] = []
    for (const thread of threads) {
      const events = await log.read({ threadId: toThreadId(thread.id) })
      const turns: { runId: string; status: string }[] = await database.prisma.turn.findMany({
        where: { threadId: thread.id, status: 'completed' },
        select: { runId: true, status: true },
      })
      const completedRuns = new Set(turns.map((turn) => turn.runId))
      const found = spansOf({
        title: thread.title ?? thread.id,
        events,
        completedRuns,
      }).slice(0, 2)
      spans.push(...found)
      if (spans.length >= LIMIT) break
    }

    console.log(`\nevaluating ${spans.length} turn(s) from ${threads.length} thread(s)\n`)

    let passed = 0
    for (const span of spans.slice(0, LIMIT)) {
      const result = await tldrFor({
        model,
        events: span.events,
        anchorSeq: span.anchorSeq,
        throughSeq: span.throughSeq,
      })

      if (result === null) {
        console.log(`✗ ${span.threadTitle} (seq ${span.anchorSeq}–${span.throughSeq})`)
        console.log('  generator returned nothing\n')
        continue
      }

      const verdict = await judge({ model, span, footer: result.text, status: result.status })
      if (verdict.pass) passed += 1
      console.log(`${verdict.pass ? '✓' : '✗'} ${span.threadTitle} (seq ${span.anchorSeq}–${span.throughSeq})`)
      console.log(`  status: ${result.status}`)
      console.log(`  footer: ${result.text.replace(/\n/g, ' ⏎ ')}`)
      console.log(`  judge:  ${verdict.note}\n`)
    }

    const total = Math.min(spans.length, LIMIT)
    console.log(`${passed}/${total} passed`)
  } finally {
    await database.close()
    await disposeAll({ container })
  }
}

await main()
