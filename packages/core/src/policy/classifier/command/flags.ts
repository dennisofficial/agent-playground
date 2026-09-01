import type { LexedToken } from './lex'

export type ArgumentSplit = {
  verb: string | undefined
  flags: readonly string[]
  flagValues: ReadonlyMap<string, string>
  operands: readonly LexedToken[]
}

const programsWithVerbs = new Set([
  'apt',
  'apt-get',
  'aws',
  'brew',
  'bun',
  'bunx',
  'cargo',
  'deno',
  'docker',
  'gcloud',
  'gh',
  'git',
  'go',
  'helm',
  'kubectl',
  'nix',
  'npm',
  'npx',
  'pip',
  'pnpm',
  'sudo',
  'systemctl',
  'terraform',
  'uv',
  'yarn',
])

const valueTakingFlags: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['git', new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace'])],
  ['docker', new Set(['-H', '--context', '--config'])],
  ['kubectl', new Set(['-n', '--namespace', '--context', '--kubeconfig'])],
  ['sudo', new Set(['-u', '-g', '-p'])],
])

const programsWhoseSingleDashFlagsAreWords = new Set(['find', 'java', 'ffmpeg', 'openssl'])

export function isFlagToken({ token }: { token: string }): boolean {
  if (token.length < 2) return false
  return token.startsWith('-')
}

export function decomposeFlag({
  token,
  program,
}: {
  token: string
  program?: string | undefined
}): readonly string[] {
  if (token === '--') return [token]

  if (token.startsWith('--')) {
    const equals = token.indexOf('=')
    if (equals === -1) return [token]
    return [token, token.slice(0, equals)]
  }

  if (program !== undefined && programsWhoseSingleDashFlagsAreWords.has(program)) return [token]

  const letters = token.slice(1)
  if (letters.includes('=')) return [token]
  return [...letters].map((letter) => `-${letter}`)
}

export function takesValue({ program, flag }: { program: string; flag: string }): boolean {
  return valueTakingFlags.get(program)?.has(flag) === true
}

export function hasVerbs({ program }: { program: string }): boolean {
  return programsWithVerbs.has(program)
}

export function splitArguments(args: {
  program: string
  words: readonly LexedToken[]
}): ArgumentSplit {
  const { program, words } = args
  const flags: string[] = []
  const flagValues = new Map<string, string>()
  const operands: LexedToken[] = []
  let verb: string | undefined
  let endOfFlags = false
  let index = 0

  while (index < words.length) {
    const word = words[index]
    index += 1
    if (word === undefined) continue

    if (endOfFlags || !isFlagToken({ token: word.text })) {
      if (verb === undefined && hasVerbs({ program }) && !endOfFlags) {
        verb = word.text
        continue
      }
      operands.push(word)
      continue
    }

    if (word.text === '--') {
      endOfFlags = true
      flags.push('--')
      continue
    }

    const equals = word.text.startsWith('--') ? word.text.indexOf('=') : -1
    if (equals !== -1) {
      flagValues.set(word.text.slice(0, equals), word.text.slice(equals + 1))
    }

    const decomposed = decomposeFlag({ token: word.text, program })
    for (const flag of decomposed) flags.push(flag)

    const last = decomposed[decomposed.length - 1]
    if (equals !== -1 || last === undefined) continue
    if (!takesValue({ program, flag: last })) continue

    const value = words[index]
    if (value === undefined) continue
    flagValues.set(last, value.text)
    index += 1
  }

  return { verb, flags, flagValues, operands }
}
