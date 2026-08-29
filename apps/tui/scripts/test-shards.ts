import { cpus } from 'node:os'

/**
 * `bun test --parallel` implies `--isolate`, and @opentui/core 0.4.5 cannot initialise its Zig
 * render library in an isolated worker — every `testRender` fails with "Cannot access 'default'
 * before initialization". `--shard` splits the same files across ordinary processes instead, which
 * the FFI is happy with. Drop this script for `--parallel` once that upstream bug is fixed.
 */

const MAXIMUM_SHARDS = 20

const COUNT = /^\s*(\d+)\s+(pass|fail)\s*$/gm

type ShardResult = {
  shard: number
  ok: boolean
  output: string
  passed: number
  failed: number
  seconds: number
}

const shardCount = (): number => {
  const asked = Number.parseInt(Bun.env.ATLAS_TEST_SHARDS ?? '', 10)
  if (Number.isFinite(asked) && asked > 0) return asked
  return Math.max(1, Math.min(MAXIMUM_SHARDS, cpus().length))
}

function tally(output: string): { passed: number; failed: number } {
  let passed = 0
  let failed = 0

  for (const [, amount, kind] of output.matchAll(COUNT)) {
    if (amount === undefined) continue
    if (kind === 'pass') passed += Number(amount)
    if (kind === 'fail') failed += Number(amount)
  }

  return { passed, failed }
}

async function runShard(args: { shard: number; of: number }): Promise<ShardResult> {
  const startedAt = Date.now()

  const child = Bun.spawn(['bun', 'test', `--shard=${args.shard}/${args.of}`], {
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

  const of = shardCount()
  const startedAt = Date.now()

  const results = await Promise.all(
    Array.from({ length: of }, (_unused, index) => runShard({ shard: index + 1, of })),
  )

  const failures = results.filter((result) => !result.ok)
  for (const failure of failures) process.stdout.write(failure.output)

  const passed = results.reduce((total, result) => total + result.passed, 0)
  const failed = results.reduce((total, result) => total + result.failed, 0)
  const slowest = Math.max(...results.map((result) => result.seconds))
  const elapsed = (Date.now() - startedAt) / 1_000

  process.stdout.write(
    `\n${passed} pass, ${failed} fail across ${of} shards in ${elapsed.toFixed(1)}s ` +
      `(slowest shard ${slowest.toFixed(1)}s)\n`,
  )

  process.exit(failures.length === 0 ? 0 : 1)
}

await main()
