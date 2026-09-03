import { probeSourceState, repoRootOf, sourceStampOf } from '../src/build/stamp'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const defineOf = (name: string, value: string): string => `${name}:${JSON.stringify(value)}`

const defines: string[] = []

const version = process.env.ATLAS_VERSION
if (version !== undefined && version !== '') {
  defines.push(defineOf('ATLAS_VERSION', version))
  const releaseRepo = process.env.ATLAS_RELEASE_REPO
  if (releaseRepo !== undefined && releaseRepo !== '') {
    defines.push(defineOf('ATLAS_RELEASE_REPO', releaseRepo))
  }
} else {
  const repo = await repoRootOf(process.cwd())
  const state = repo === null ? null : await probeSourceState({ repo })
  if (repo !== null && state !== null) {
    defines.push(defineOf('ATLAS_BUILD_REPO', repo))
    defines.push(defineOf('ATLAS_BUILD_STAMP', sourceStampOf(state)))
  } else {
    console.warn('not a git tree: building without a staleness stamp')
  }
}

const cmd = [
  'bun',
  'build',
  '--compile',
  ...defines.flatMap((define) => ['--define', define]),
  ...(arg('--target') === undefined ? [] : ['--target', arg('--target') as string]),
  'src/main.tsx',
  '--outfile',
  arg('--outfile') ?? 'bin/atlas',
]

const build = Bun.spawnSync({ cmd, stdout: 'inherit', stderr: 'inherit' })
process.exit(build.exitCode)
