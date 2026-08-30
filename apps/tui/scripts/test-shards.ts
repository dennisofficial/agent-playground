import { cpus } from 'node:os'

/**
 * `bun test --parallel` implies `--isolate`, and @opentui/core 0.4.5 cannot initialise its Zig
 * render library in an isolated worker — every `testRender` fails with "Cannot access 'default'
 * before initialization" — still true on bun 1.3.14, where it fails 502 of 2121 tests. Ordinary
 * processes are fine, so the files are split here and handed out as explicit path filters rather
 * than through `bun test --shard`, which exists only from 1.3.14 and is accepted and ignored by
 * older bun, where a shard that silently runs the whole suite still reads as a pass.
 */

const MAXIMUM_SHARDS = 20

const SPEC_GLOB = 'src/**/*.spec.{ts,tsx}'

const COUNT = /^\s*(\d+)\s+(pass|fail)\s*$/gm

const RAN = /^Ran \d+ tests? across (\d+) files?\./gm

type ShardResult = {
  shard: number
  ok: boolean
  output: string
  passed: number
  failed: number
  filesRan: number
  seconds: number
}

const shardCount = ({ files }: { files: number }): number => {
  const asked = Number.parseInt(Bun.env.ATLAS_TEST_SHARDS ?? '', 10)
  const wanted = Number.isFinite(asked) && asked > 0 ? asked : cpus().length
  return Math.max(1, Math.min(MAXIMUM_SHARDS, wanted, files))
}

async function specFiles(): Promise<string[]> {
  const found: string[] = []
  for await (const file of new Bun.Glob(SPEC_GLOB).scan({ cwd: `${import.meta.dir}/..` })) {
    found.push(file)
  }
  return found.sort()
}

function partition({ files, of }: { files: readonly string[]; of: number }): string[][] {
  const shards = Array.from({ length: of }, (): string[] => [])
  files.forEach((file, index) => shards[index % of]?.push(file))
  return shards
}

function tally(output: string): { passed: number; failed: number; filesRan: number } {
  let passed = 0
  let failed = 0
  let filesRan = 0

  for (const [, amount, kind] of output.matchAll(COUNT)) {
    if (amount === undefined) continue
    if (kind === 'pass') passed += Number(amount)
    if (kind === 'fail') failed += Number(amount)
  }

  for (const [, amount] of output.matchAll(RAN)) {
    if (amount !== undefined) filesRan += Number(amount)
  }

  return { passed, failed, filesRan }
}

async function runShard(args: { shard: number; files: readonly string[] }): Promise<ShardResult> {
  const startedAt = Date.now()

  const child = Bun.spawn(['bun', 'test', ...args.files], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  const output = `${out}${err}`

  return {
    shard: args.shard,
    ok: code === 0,
    output,
    ...tally(output),
    seconds: (Date.now() - startedAt) / 1_000,
  }
}

async function main(): Promise<void> {
  const forwarded = Bun.argv.slice(2)

  if (forwarded.length > 0) {
    const child = Bun.spawn(['bun', 'test', ...forwarded], { stdout: 'inherit', stderr: 'inherit' })
    process.exit(await child.exited)
  }

  const files = await specFiles()

  if (files.length === 0) {
    process.stdout.write(`no spec file matched ${SPEC_GLOB}\n`)
    process.exit(1)
  }

  const of = shardCount({ files: files.length })
  const startedAt = Date.now()

  const results = await Promise.all(
    partition({ files, of }).map((shardFiles, index) =>
      runShard({ shard: index + 1, files: shardFiles }),
    ),
  )

  const failures = results.filter((result) => !result.ok)
  for (const failure of failures) process.stdout.write(failure.output)

  const passed = results.reduce((total, result) => total + result.passed, 0)
  const failed = results.reduce((total, result) => total + result.failed, 0)
  const filesRan = results.reduce((total, result) => total + result.filesRan, 0)
  const slowest = Math.max(...results.map((result) => result.seconds))
  const elapsed = (Date.now() - startedAt) / 1_000

  process.stdout.write(
    `\n${passed} pass, ${failed} fail across ${of} shards in ${elapsed.toFixed(1)}s ` +
      `(slowest shard ${slowest.toFixed(1)}s)\n`,
  )

  if (filesRan !== files.length) {
    process.stdout.write(
      `sharding is not splitting the suite: dispatched ${files.length} files, ran ${filesRan}\n`,
    )
    process.exit(1)
  }

  process.exit(failures.length === 0 ? 0 : 1)
}

await main()
