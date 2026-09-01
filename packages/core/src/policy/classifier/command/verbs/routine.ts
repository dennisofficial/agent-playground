import { readOnly, routine, verbOf, type CommandView, type VerbTable } from './view'
import { shellKeywords } from '../vocabulary'

const readingPrograms = new Set([
  'ack',
  'ag',
  'awk',
  'base64',
  'basename',
  'bat',
  'cat',
  'cksum',
  'cmp',
  'column',
  'comm',
  'cut',
  'date',
  'df',
  'diff',
  'dirname',
  'du',
  'echo',
  'env',
  'fd',
  'file',
  'find',
  'grep',
  'head',
  'hostname',
  'id',
  'jq',
  'less',
  'locale',
  'lsof',
  'ls',
  'md5sum',
  'more',
  'nl',
  'od',
  'paste',
  'printenv',
  'printf',
  'ps',
  'pwd',
  'realpath',
  'readlink',
  'rev',
  'rg',
  'sed',
  'seq',
  'sha1sum',
  'sha256sum',
  'shasum',
  'sort',
  'stat',
  'strings',
  'tail',
  'tr',
  'tree',
  'type',
  'uname',
  'uniq',
  'wc',
  'whoami',
  'which',
  'xxd',
  'yq',
])

const runnerPrograms = new Set([
  'biome',
  'bun',
  'cd',
  'deno',
  'eslint',
  'export',
  'false',
  'jest',
  'mocha',
  'node',
  'oxlint',
  'prettier',
  'pytest',
  'sleep',
  'test',
  'true',
  'tsc',
  'tsx',
  'turbo',
  'vitest',
])

const verbsThatLeaveTheRunner: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['bun', new Set(['x', 'create', 'init', 'link', 'publish', 'upgrade'])],
  ['deno', new Set(['compile', 'publish', 'upgrade'])],
  ['make', new Set(['clean', 'distclean', 'uninstall', 'purge', 'reset'])],
  ['cargo', new Set(['publish', 'install', 'uninstall'])],
  ['go', new Set(['install', 'get'])],
])

const verbRunners: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['cargo', new Set(['bench', 'build', 'check', 'clippy', 'doc', 'fmt', 'run', 'test', 'tree'])],
  ['go', new Set(['build', 'doc', 'fmt', 'list', 'run', 'test', 'version', 'vet'])],
  ['make', new Set([])],
])

function runnerSketch({ view }: { view: CommandView }) {
  const verb = verbOf({ view })
  if (verb !== undefined && verbsThatLeaveTheRunner.get(view.program)?.has(verb) === true) {
    return undefined
  }

  const allowed = verbRunners.get(view.program)
  if (allowed === undefined || allowed.size === 0 || verb === undefined) {
    return routine({ summary: `runs the project's own tooling (${view.program})` })
  }
  if (!allowed.has(verb)) return undefined

  return routine({ summary: `runs the project's own tooling (${view.program} ${verb})` })
}

export const routineVerbs: VerbTable = ({ view }) => {
  if (shellKeywords.has(view.program)) return routine({ summary: 'a shell control structure' })
  if (readingPrograms.has(view.program))
    return readOnly({ summary: `reads local state (${view.program})` })
  if (runnerPrograms.has(view.program) || verbRunners.has(view.program)) {
    return runnerSketch({ view })
  }

  return undefined
}
