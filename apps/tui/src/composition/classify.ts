export const CLASSIFY_COMMAND = 'classify'

export enum EClassifyTask {
  Replay = 'replay',
  Critique = 'critique',
  Usage = 'usage',
}

export type ClassifyRequest =
  | {
      task: EClassifyTask.Replay
      threadId: string
      judge: boolean
      capture: boolean
      misses: boolean
    }
  | { task: EClassifyTask.Critique }
  | { task: EClassifyTask.Usage; complaint: string | undefined }

const REPLAY_FLAG = '--replay'
const CRITIQUE_FLAG = '--critique'
const JUDGE_FLAG = '--judge'
const CAPTURE_FLAG = '--capture'
const MISSES_FLAG = '--misses'
const HELP_FLAGS: readonly string[] = ['--help', '-h']

export const CLASSIFY_USAGE: readonly string[] = [
  'atlas classify --replay <threadId> [--judge] [--capture] [--misses]',
  '    replays a recorded thread through the current probes and prints what would have',
  '    cleared, consulted and asked. Offline and free unless --judge is given.',
  '',
  '    --judge     also consult the model on every candidate that survives triage (network).',
  '    --capture   write each candidate to .scratch/auto-classifier/corpus as a regression case.',
  '    --misses    list the cleared calls the thread went on to undo, one line each.',
  '',
  'atlas classify --critique',
  '    asks the model to review the classifier configuration itself (network).',
]

const valueAfter = ({
  argv,
  flag,
}: {
  argv: readonly string[]
  flag: string
}): string | undefined => {
  const at = argv.indexOf(flag)
  if (at < 0) return undefined

  const named = argv[at + 1]
  return named === undefined || named.startsWith('-') ? undefined : named
}

export function classifyRequestOf({
  argv,
}: {
  argv: readonly string[]
}): ClassifyRequest | undefined {
  if (argv[0] !== CLASSIFY_COMMAND) return undefined
  if (argv.some((arg) => HELP_FLAGS.includes(arg))) {
    return { task: EClassifyTask.Usage, complaint: undefined }
  }

  if (argv.includes(CRITIQUE_FLAG)) return { task: EClassifyTask.Critique }

  if (!argv.includes(REPLAY_FLAG)) {
    return { task: EClassifyTask.Usage, complaint: 'classify needs --replay or --critique' }
  }

  const threadId = valueAfter({ argv, flag: REPLAY_FLAG })
  if (threadId === undefined) {
    return { task: EClassifyTask.Usage, complaint: '--replay needs the id of a recorded thread' }
  }

  return {
    task: EClassifyTask.Replay,
    threadId,
    judge: argv.includes(JUDGE_FLAG),
    capture: argv.includes(CAPTURE_FLAG),
    misses: argv.includes(MISSES_FLAG),
  }
}
