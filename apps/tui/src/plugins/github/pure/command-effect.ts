export enum ECommandEffect {
  StartsWork = 'starts-work',
  ChangesPullRequest = 'changes-pull-request',
  Nothing = 'nothing',
}

const CHAIN = /&&|\|\||;|\||\n/

const PUSH = 'push'

const DRY_RUN = '--dry-run'

const GH_STARTS_WORK: readonly (readonly string[])[] = [
  ['pr', 'create'],
  ['pr', 'ready'],
  ['workflow', 'run'],
  ['run', 'rerun'],
]

const GH_CHANGES_PULL_REQUEST: readonly (readonly string[])[] = [
  ['pr', 'merge'],
  ['pr', 'close'],
  ['pr', 'reopen'],
]

const tokensOf = (segment: string): readonly string[] =>
  segment.split(/\s+/).filter((token) => token.length > 0)

const pushes = (rest: readonly string[]): boolean => rest.includes(PUSH) && !rest.includes(DRY_RUN)

const names = (args: {
  rest: readonly string[]
  verbs: readonly (readonly string[])[]
}): boolean => {
  const words = args.rest.filter((token) => !token.startsWith('-'))
  return args.verbs.some((verb) => verb.every((word, index) => words[index] === word))
}

/**
 * The program is looked for as a whole token anywhere in the link rather than at its head, which is
 * what carries `FOO=1 git push`, `git -C dir push` and `sudo -E git push` without any of them being
 * special-cased. Quoting is what keeps `echo "git push"` out: the quote stays glued to the token, so
 * `"git` is not `git`.
 */
const segmentEffect = (segment: string): ECommandEffect => {
  const tokens = tokensOf(segment)

  const git = tokens.indexOf('git')
  if (git !== -1 && pushes(tokens.slice(git + 1))) return ECommandEffect.StartsWork

  const gh = tokens.indexOf('gh')
  if (gh === -1) return ECommandEffect.Nothing

  const rest = tokens.slice(gh + 1)
  if (names({ rest, verbs: GH_STARTS_WORK })) return ECommandEffect.StartsWork
  if (names({ rest, verbs: GH_CHANGES_PULL_REQUEST })) return ECommandEffect.ChangesPullRequest

  return ECommandEffect.Nothing
}

/**
 * Word matching over each link of a command chain, never a shell parse. The bias is deliberate: a
 * miss costs nothing but today's five-minute wait, while a false match costs one `gh` call, so the
 * rule is allowed to be generous and is not allowed to be clever.
 *
 * The two effects are one function rather than two predicates because a chain can hold both —
 * `git push && gh pr merge` — and the precedence has to be decided somewhere rather than at each
 * call site. Starting work wins: waiting for a check that does not exist yet is what needs the
 * eager window, and the state change will be seen by the first read that window buys anyway.
 */
export function commandEffect({ command }: { command: string }): ECommandEffect {
  const effects = command.split(CHAIN).map(segmentEffect)
  if (effects.includes(ECommandEffect.StartsWork)) return ECommandEffect.StartsWork
  if (effects.includes(ECommandEffect.ChangesPullRequest)) return ECommandEffect.ChangesPullRequest

  return ECommandEffect.Nothing
}
