import { EDeed, EDeedRealm, type DeedTarget } from '../../deed'
import {
  readOnly,
  sketch,
  subverbOf,
  verbOf,
  type CommandView,
  type DeedSketch,
  type VerbTable,
} from './view'

const packageManagers = new Set([
  'apt',
  'apt-get',
  'brew',
  'bun',
  'cargo',
  'composer',
  'deno',
  'gem',
  'go',
  'npm',
  'pip',
  'pip3',
  'pnpm',
  'poetry',
  'uv',
  'yarn',
])

const mutatingVerbs = new Set([
  'add',
  'ci',
  'dedupe',
  'get',
  'i',
  'install',
  'link',
  'patch',
  'prune',
  'rebuild',
  'remove',
  'rm',
  'uninstall',
  'un',
  'unlink',
  'up',
  'update',
  'upgrade',
])

const readingVerbs = new Set([
  'audit',
  'info',
  'licenses',
  'list',
  'ls',
  'outdated',
  'root',
  'search',
  'show',
  'view',
  'why',
])

const readingManagerSubverbs = new Set(['bin', 'hash', 'ls', 'untrusted', 'version'])

function packageTargets({ view }: { view: CommandView }): readonly DeedTarget[] {
  const named = view.words.slice(1).map((word) => ({ realm: EDeedRealm.Package, value: word.raw }))
  if (view.cwd === undefined) return named
  return [...named, { realm: EDeedRealm.Path, value: view.cwd }]
}

function bunPackageManager({ view }: { view: CommandView }): DeedSketch {
  const verb = subverbOf({ view })
  if (verb === undefined || readingManagerSubverbs.has(verb)) {
    return readOnly({ summary: 'reads package manager state' })
  }

  return sketch({
    action: EDeed.MutateDependencies,
    targets: packageTargets({ view }),
    summary: 'changes which packages the workspace trusts or installs',
  })
}

export const packageVerbs: VerbTable = ({ view }) => {
  if (!packageManagers.has(view.program)) return undefined

  const verb = verbOf({ view })
  if (verb === undefined) return undefined
  if (verb === 'pm') return bunPackageManager({ view })
  if (readingVerbs.has(verb))
    return readOnly({ summary: `reads dependency state (${view.program} ${verb})` })
  if (!mutatingVerbs.has(verb)) return undefined

  return sketch({
    action: EDeed.MutateDependencies,
    targets: packageTargets({ view }),
    summary: 'changes the installed dependencies and the lockfile',
  })
}
