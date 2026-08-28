import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EToolEffect, type ToolOutcome } from '@dltech/atlas-core'

import { EShellStatus } from '../../../shells/background-shell'
import { BunShellRegistry } from '../../../shells/shell-registry'
import { SystemClock } from '../../../store'
import { BashTool } from '../bash'
import { ShellKillTool } from '../shell-kill'
import { ShellListTool } from '../shell-list'
import { ShellOutputTool } from '../shell-output'

type Suite = {
  root: string
  shells: BunShellRegistry
  bash: BashTool
  output: ShellOutputTool
  kill: ShellKillTool
  list: ShellListTool
}

const opened: Suite[] = []

afterEach(async () => {
  for (const suite of opened.splice(0)) {
    await suite.shells.closeAll()
    rmSync(suite.root, { recursive: true, force: true })
  }
})

function openSuite(): Suite {
  const root = mkdtempSync(join(tmpdir(), 'atlas-shell-tools-'))
  const shells = new BunShellRegistry(root, new SystemClock())
  const suite: Suite = {
    root,
    shells,
    bash: new BashTool(root, shells),
    output: new ShellOutputTool(shells),
    kill: new ShellKillTool(shells),
    list: new ShellListTool(shells),
  }
  opened.push(suite)
  return suite
}

const invoke = (tool: { invoke: (args: never) => Promise<ToolOutcome> }, input: unknown): Promise<ToolOutcome> =>
  tool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'key-1',
  } as never)

const outputOf = (outcome: ToolOutcome): Record<string, unknown> => {
  if (!outcome.ok) throw new Error(`expected success, got: ${outcome.reason}`)
  return outcome.output as Record<string, unknown>
}

const modelTextOf = (outcome: ToolOutcome): string => {
  if (!outcome.ok) throw new Error(`expected success, got: ${outcome.reason}`)
  return outcome.modelText
}

async function settled(suite: Suite, shellId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = suite.shells.list().find((entry) => entry.shellId === shellId)
    if (snapshot !== undefined && snapshot.status !== EShellStatus.Running) return
    await Bun.sleep(25)
  }
  throw new Error(`${shellId} never left running`)
}

describe('asking bash to run something in the background', () => {
  it('comes back with a shell id instead of waiting for a long command', async () => {
    const suite = openSuite()

    const outcome = await invoke(suite.bash, { command: 'sleep 30', runInBackground: true })

    const output = outputOf(outcome)
    expect(output.shellId).toBe('bash_1')
    expect(output.status).toBe(EShellStatus.Running)
    expect(modelTextOf(outcome)).toContain('Its ending will be delivered to you')
  })

  it('returns before a slow command could possibly have finished', async () => {
    const suite = openSuite()
    const before = Date.now()

    await invoke(suite.bash, { command: 'sleep 10', runInBackground: true })

    expect(Date.now() - before).toBeLessThan(2_000)
  })

  it('names the tools that read and stop it', async () => {
    const suite = openSuite()

    const outcome = await invoke(suite.bash, { command: 'sleep 30', runInBackground: true })

    expect(modelTextOf(outcome)).toContain('shell_output')
    expect(modelTextOf(outcome)).toContain('shell_kill')
  })

  it('refuses a timeout on a background shell rather than ignoring it', async () => {
    const suite = openSuite()

    const outcome = await invoke(suite.bash, {
      command: 'sleep 30',
      runInBackground: true,
      timeoutMs: 5_000,
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('no timeout')
  })

  it('still waits for a command when runInBackground is absent', async () => {
    const suite = openSuite()

    const outcome = await invoke(suite.bash, { command: 'echo waited' })

    expect(String(outputOf(outcome).stdout)).toContain('waited')
    expect(suite.shells.list()).toEqual([])
  })

  it('stays unsafe to run concurrently, background or not', () => {
    const suite = openSuite()

    expect(suite.bash.effect).toBe(EToolEffect.Destructive)
    expect(suite.bash.isConcurrencySafe).toBeUndefined()
  })
})

describe('reading a background shell through shell_output', () => {
  it('hands back what the command printed once it has finished', async () => {
    const suite = openSuite()
    const started = outputOf(await invoke(suite.bash, { command: 'echo hello', runInBackground: true }))
    await settled(suite, String(started.shellId))

    const outcome = await invoke(suite.output, { shellId: started.shellId })

    expect(String(outputOf(outcome).text)).toBe('hello\n')
    expect(modelTextOf(outcome)).toContain('finished successfully')
    expect(modelTextOf(outcome)).toContain('hello')
  })

  it('consumes what it returns, so the second read is not the first again', async () => {
    const suite = openSuite()
    const started = outputOf(await invoke(suite.bash, { command: 'echo once', runInBackground: true }))
    await settled(suite, String(started.shellId))

    await invoke(suite.output, { shellId: started.shellId })
    const again = await invoke(suite.output, { shellId: started.shellId })

    expect(outputOf(again).text).toBe('')
    expect(modelTextOf(again)).toContain('printed nothing more')
  })

  it('says a shell is still running rather than implying it finished', async () => {
    const suite = openSuite()
    const started = outputOf(await invoke(suite.bash, { command: 'sleep 30', runInBackground: true }))

    const outcome = await invoke(suite.output, { shellId: started.shellId })

    expect(modelTextOf(outcome)).toContain('still running')
  })

  it('reports a failing exit code', async () => {
    const suite = openSuite()
    const started = outputOf(await invoke(suite.bash, { command: 'exit 4', runInBackground: true }))
    await settled(suite, String(started.shellId))

    const outcome = await invoke(suite.output, { shellId: started.shellId })

    expect(outputOf(outcome).exitCode).toBe(4)
    expect(modelTextOf(outcome)).toContain('exit code 4')
  })

  it('fails with a correctable message on an unknown shell id', async () => {
    const suite = openSuite()
    await invoke(suite.bash, { command: 'sleep 30', runInBackground: true })

    const outcome = await invoke(suite.output, { shellId: 'bash_404' })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('bash_404')
    expect(outcome.reason).toContain('bash_1')
  })

  it('is safe to run alongside other reads', () => {
    const suite = openSuite()

    expect(suite.output.effect).toBe(EToolEffect.Read)
    expect(suite.output.isConcurrencySafe?.()).toBe(true)
  })
})

describe('stopping a background shell through shell_kill', () => {
  it('stops a running shell and leaves its output readable', async () => {
    const suite = openSuite()
    const started = outputOf(
      await invoke(suite.bash, { command: 'echo before; sleep 60', runInBackground: true }),
    )
    await Bun.sleep(200)

    const killed = await invoke(suite.kill, { shellId: started.shellId })
    await settled(suite, String(started.shellId))

    expect(modelTextOf(killed)).toContain('process group')
    const read = await invoke(suite.output, { shellId: started.shellId })
    expect(String(outputOf(read).text)).toContain('before')
    expect(outputOf(read).status).toBe(EShellStatus.Killed)
  })

  it('says so rather than pretending, when the shell had already finished', async () => {
    const suite = openSuite()
    const started = outputOf(await invoke(suite.bash, { command: 'echo quick', runInBackground: true }))
    await settled(suite, String(started.shellId))

    const killed = await invoke(suite.kill, { shellId: started.shellId })

    expect(modelTextOf(killed)).toContain('had already finished')
  })

  it('fails with a correctable message on an unknown shell id', async () => {
    const suite = openSuite()

    const outcome = await invoke(suite.kill, { shellId: 'bash_9' })

    expect(outcome.ok).toBe(false)
  })

  it('is never run concurrently, since it changes the world', () => {
    const suite = openSuite()

    expect(suite.kill.effect).toBe(EToolEffect.Destructive)
    expect(suite.kill.isConcurrencySafe).toBeUndefined()
  })
})

describe('telling the model it will hear about the ending', () => {
  it('promises the notice and says the output rides along, so nothing invites a poll', async () => {
    const suite = openSuite()

    const outcome = await invoke(suite.bash, { command: 'sleep 30', runInBackground: true })

    expect(modelTextOf(outcome)).toContain('Its ending will be delivered to you with everything it printed')
    expect(modelTextOf(outcome)).toContain('no polling')
  })

  it('names waiting on the shell as the mistake and ending the turn as the alternative', async () => {
    const suite = openSuite()

    const outcome = await invoke(suite.bash, { command: 'sleep 30', runInBackground: true })

    expect(modelTextOf(outcome)).toContain('no sleeping')
    expect(modelTextOf(outcome)).toContain('end the turn and be woken')
  })

  it('scopes shell_output to a shell that will not end on its own', async () => {
    const suite = openSuite()

    const outcome = await invoke(suite.bash, { command: 'sleep 30', runInBackground: true })

    expect(modelTextOf(outcome)).toContain('only for a shell that will not end on its own')
  })

  it('offers no way to turn the notice off', async () => {
    const suite = openSuite()

    const outcome = await invoke(suite.bash, {
      command: 'sleep 30',
      runInBackground: true,
      notifyOnExit: 'never',
    })

    expect(outcome.ok).toBe(false)
  })
})

describe('listing background shells through shell_list', () => {
  it('says plainly when the session has started none', async () => {
    const suite = openSuite()

    const outcome = await invoke(suite.list, {})

    expect(modelTextOf(outcome)).toContain('no background shells')
  })

  it('names every shell with its command and state', async () => {
    const suite = openSuite()
    await invoke(suite.bash, { command: 'sleep 30', runInBackground: true })
    await invoke(suite.bash, { command: 'sleep 31', runInBackground: true })

    const outcome = await invoke(suite.list, {})

    expect(modelTextOf(outcome)).toContain('bash_1')
    expect(modelTextOf(outcome)).toContain('bash_2')
    expect(modelTextOf(outcome)).toContain('sleep 30')
    expect(modelTextOf(outcome)).toContain('running')
  })

  it('keeps a finished shell listed, so its output stays findable', async () => {
    const suite = openSuite()
    const started = outputOf(await invoke(suite.bash, { command: 'exit 5', runInBackground: true }))
    await settled(suite, String(started.shellId))

    const outcome = await invoke(suite.list, {})

    expect(modelTextOf(outcome)).toContain('exit code 5')
  })

  it('leaves the finished ones out when asked for only what is running', async () => {
    const suite = openSuite()
    const done = outputOf(await invoke(suite.bash, { command: 'echo done', runInBackground: true }))
    await settled(suite, String(done.shellId))
    await invoke(suite.bash, { command: 'sleep 30', runInBackground: true })

    const outcome = await invoke(suite.list, { runningOnly: true })

    expect(modelTextOf(outcome)).toContain('bash_2')
    expect(modelTextOf(outcome)).not.toContain('bash_1')
  })

  it('says a shell stuck on a prompt must be killed rather than waited on', async () => {
    const suite = openSuite()
    await invoke(suite.bash, { command: `printf 'Password: '; sleep 30`, runInBackground: true })
    await Bun.sleep(300)

    const outcome = await invoke(suite.list, {})

    expect(modelTextOf(outcome)).toContain('awaiting input')
    expect(modelTextOf(outcome)).toContain('kill it')
  })

  it('does not consume the output the model has yet to read', async () => {
    const suite = openSuite()
    const started = outputOf(await invoke(suite.bash, { command: 'echo kept', runInBackground: true }))
    await settled(suite, String(started.shellId))

    await invoke(suite.list, {})
    const read = await invoke(suite.output, { shellId: started.shellId })

    expect(String(outputOf(read).text)).toBe('kept\n')
  })

  it('is safe to run alongside other reads', () => {
    const suite = openSuite()

    expect(suite.list.effect).toBe(EToolEffect.Read)
    expect(suite.list.isConcurrencySafe?.()).toBe(true)
  })
})
