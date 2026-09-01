import { EDeed, EDeedRealm, type DeedTarget } from '../../deed'
import {
  anyFlag,
  readOnly,
  sketch,
  subverbOf,
  verbOf,
  type CommandView,
  type DeedSketch,
  type VerbTable,
} from './view'

const bodyFlags = [
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '--json',
  '-F',
  '--form',
  '-T',
  '--upload-file',
  '--post-data',
]

const writingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const deployingVerbs: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['terraform', new Set(['apply', 'destroy', 'import', 'taint', 'untaint', 'state'])],
  ['wrangler', new Set(['publish', 'deploy', 'delete'])],
  ['flyctl', new Set(['deploy', 'destroy', 'scale'])],
  ['fly', new Set(['deploy', 'destroy', 'scale'])],
  ['vercel', new Set(['deploy', 'promote', 'rollback', 'remove', 'rm', 'alias'])],
  ['kubectl', new Set(['apply', 'delete', 'patch', 'replace', 'scale', 'rollout', 'drain'])],
  ['helm', new Set(['install', 'upgrade', 'uninstall', 'rollback', 'delete'])],
  ['heroku', new Set(['releases:rollback', 'ps:scale'])],
])

const readingVerbs: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['terraform', new Set(['plan', 'show', 'validate', 'fmt', 'output', 'version', 'providers'])],
  ['wrangler', new Set(['tail', 'whoami', 'dev'])],
  ['flyctl', new Set(['status', 'logs', 'list'])],
  ['fly', new Set(['status', 'logs', 'list'])],
  ['vercel', new Set(['ls', 'list', 'inspect', 'logs', 'whoami', 'env'])],
  ['kubectl', new Set(['get', 'describe', 'logs', 'explain', 'config', 'version', 'top'])],
  ['helm', new Set(['list', 'status', 'get', 'history', 'search', 'template'])],
])

const publishingVerbs = new Set(['publish'])

const readingGitHubVerbs: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['pr', new Set(['view', 'list', 'diff', 'checks', 'status'])],
  ['issue', new Set(['view', 'list', 'status'])],
  ['run', new Set(['view', 'list', 'watch', 'download'])],
  ['release', new Set(['view', 'list', 'download'])],
  ['repo', new Set(['view', 'list', 'clone'])],
  ['auth', new Set(['status'])],
  ['workflow', new Set(['view', 'list'])],
])

const outboundGitHubVerbs: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['pr', new Set(['create', 'comment', 'edit', 'review', 'ready', 'close', 'reopen'])],
  ['issue', new Set(['create', 'comment', 'edit', 'close', 'reopen'])],
])

const publishingGitHubVerbs: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['release', new Set(['create', 'upload', 'edit', 'delete'])],
])

function urlTargets({ view }: { view: CommandView }): readonly DeedTarget[] {
  return view.words
    .filter((word) => word.raw.includes('://'))
    .map((word) => ({ realm: EDeedRealm.Remote, value: word.raw }))
}

function transfer({ view }: { view: CommandView }): DeedSketch {
  const method = view.words.find((word) => writingMethods.has(word.raw))
  const sends = anyFlag({ view, flags: bodyFlags }) || method !== undefined
  if (!sends) return readOnly({ summary: 'fetches a URL' })

  return sketch({
    action: EDeed.SendOutbound,
    targets: urlTargets({ view }),
    summary: 'sends data to a remote endpoint',
  })
}

function github({ view }: { view: CommandView }): DeedSketch | undefined {
  const area = verbOf({ view })
  const verb = subverbOf({ view })
  if (area === undefined || verb === undefined) return undefined
  if (readingGitHubVerbs.get(area)?.has(verb) === true) {
    return readOnly({ summary: `reads GitHub state (gh ${area} ${verb})` })
  }
  if (publishingGitHubVerbs.get(area)?.has(verb) === true) {
    return sketch({ action: EDeed.PublishArtifact, summary: 'changes a published release' })
  }
  if (outboundGitHubVerbs.get(area)?.has(verb) === true) {
    return sketch({ action: EDeed.SendOutbound, summary: `posts to GitHub (gh ${area} ${verb})` })
  }

  return undefined
}

function objectStore({ view }: { view: CommandView }): DeedSketch | undefined {
  const verb = subverbOf({ view })
  if (verb === undefined) return undefined
  if (verb === 'rm' || verb === 'mb' || verb === 'rb' || verb === 'sync' || verb === 'mv') {
    return sketch({
      action: EDeed.DeployEnvironment,
      targets: urlTargets({ view }),
      summary: 'changes remote object storage',
    })
  }
  if (verb === 'ls' || verb === 'cp' || verb === 'presign') {
    return readOnly({ summary: 'reads remote object storage' })
  }

  return undefined
}

export const networkVerbs: VerbTable = ({ view }) => {
  const { program } = view
  if (program === 'curl' || program === 'wget') return transfer({ view })
  if (program === 'gh') return github({ view })

  const verb = verbOf({ view })
  if (verb === undefined) return undefined

  if (program === 'aws') return verb === 's3' ? objectStore({ view }) : undefined
  if (program === 'docker' && verb === 'push') {
    return sketch({ action: EDeed.PublishArtifact, summary: 'pushes an image to a registry' })
  }
  if (readingVerbs.get(program)?.has(verb) === true) {
    return readOnly({ summary: `reads deployment state (${program} ${verb})` })
  }
  if (deployingVerbs.get(program)?.has(verb) === true) {
    return sketch({
      action: EDeed.DeployEnvironment,
      summary: `changes a deployed environment (${program} ${verb})`,
    })
  }
  if (publishingVerbs.has(verb)) {
    return sketch({
      action: EDeed.PublishArtifact,
      summary: `publishes a package (${program} publish)`,
    })
  }

  return undefined
}
