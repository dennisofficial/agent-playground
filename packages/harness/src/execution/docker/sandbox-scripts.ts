import { demuxExecStream } from './frames'
import type { SandboxConfig, SandboxEngine } from './sandbox'

export class SandboxSetupFailed extends Error {
  constructor(args: { name: string; output: string }) {
    super(
      `setup failed in ${args.name} — the container exists but its toolchain script did not finish, so remove ${args.name} and start again. output: ${args.output}`,
    )
    this.name = 'SandboxSetupFailed'
  }
}

export type ScriptOutcome = {
  exitCode: number
  output: string
}

const OUTPUT_TAIL = 2000

const collectText = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) chunks.push(value)
  }

  const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(merged)
}

const exitCodeOf = async (args: { engine: SandboxEngine; execId: string }): Promise<number> => {
  for (;;) {
    const state = await args.engine.inspectExec({ execId: args.execId })
    if (!state.running && state.exitCode !== null) return state.exitCode
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export async function runSandboxScript(args: {
  engine: SandboxEngine
  containerId: string
  script: string
  cwd: string
  user?: string | undefined
}): Promise<ScriptOutcome> {
  const exec = await args.engine.createExec({
    containerId: args.containerId,
    cmd: ['sh', '-c', args.script],
    cwd: args.cwd,
    env: {},
    ...(args.user === undefined ? {} : { user: args.user }),
  })
  const demuxed = demuxExecStream({ stream: await args.engine.startExec({ execId: exec.id }) })
  const [stdout, stderr] = await Promise.all([
    collectText(demuxed.stdout),
    collectText(demuxed.stderr),
  ])
  await demuxed.done

  return {
    exitCode: await exitCodeOf({ engine: args.engine, execId: exec.id }),
    output: `${stdout}${stderr}`.trim(),
  }
}

export async function runSandboxScripts(args: {
  engine: SandboxEngine
  containerId: string
  name: string
  config: SandboxConfig
  created: boolean
}): Promise<readonly string[]> {
  const warnings: string[] = []

  if (args.created && args.config.setup !== undefined) {
    const setup = await runSandboxScript({
      engine: args.engine,
      containerId: args.containerId,
      script: args.config.setup,
      cwd: args.config.worktree,
      user: '0',
    })
    if (setup.exitCode !== 0) {
      throw new SandboxSetupFailed({ name: args.name, output: setup.output.slice(-OUTPUT_TAIL) })
    }
  }

  if (args.config.start !== undefined) {
    const start = await runSandboxScript({
      engine: args.engine,
      containerId: args.containerId,
      script: args.config.start,
      cwd: args.config.worktree,
    })
    if (start.exitCode !== 0) {
      warnings.push(
        `the start command exited ${start.exitCode} in ${args.name}: ${start.output.slice(-OUTPUT_TAIL)}`,
      )
    }
  }

  return warnings
}
