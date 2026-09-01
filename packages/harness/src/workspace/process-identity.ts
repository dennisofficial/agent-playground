import type { WorktreeLockIdentity } from '@dltech/atlas-core'

const START_TIME_ARGS = ['-o', 'lstart=', '-p'] as const

export async function startTimeOf({ pid }: { pid: number }): Promise<string | undefined> {
  try {
    const ps = Bun.spawn(['ps', ...START_TIME_ARGS, String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    const [stdout, status] = await Promise.all([new Response(ps.stdout).text(), ps.exited])
    if (status !== 0) return undefined

    const start = stdout.trim()
    return start.length === 0 ? undefined : start
  } catch {
    return undefined
  }
}

export function isProcessAlive({ pid }: { pid: number }): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function ownIdentity(): Promise<WorktreeLockIdentity> {
  return { pid: process.pid, start: await startTimeOf({ pid: process.pid }) }
}

export async function holderIsLive({ pid, start }: WorktreeLockIdentity): Promise<boolean> {
  if (!isProcessAlive({ pid })) return false
  if (start === undefined) return true

  const current = await startTimeOf({ pid })
  return current === undefined ? true : current === start
}
