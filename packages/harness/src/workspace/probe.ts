import { realpath } from 'node:fs/promises'

import { workspaceFrom, type WorkspaceIdentity } from '@dltech/atlas-core'

// `--path-format=absolute` is git 2.31 and newer. An older git fails the call, which lands on the
// cwd fallback rather than reporting a relative path as if it were absolute.
const REV_PARSE = [
  'git',
  'rev-parse',
  '--path-format=absolute',
  '--show-toplevel',
  '--git-common-dir',
]

const canonical = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

const revParse = async (cwd: string): Promise<readonly string[] | null> => {
  try {
    const git = Bun.spawn(REV_PARSE, { cwd, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const [output, status] = await Promise.all([new Response(git.stdout).text(), git.exited])
    if (status !== 0) return null

    return output.split('\n').map((line) => line.trim())
  } catch {
    return null
  }
}

export async function probeWorkspace({ cwd }: { cwd: string }): Promise<WorkspaceIdentity> {
  const here = await canonical(cwd)
  const lines = await revParse(here)
  if (lines === null) return workspaceFrom({ cwd: here })

  const [toplevel, commonDir] = lines
  if (toplevel === undefined || toplevel.length === 0) return workspaceFrom({ cwd: here })

  return workspaceFrom({
    cwd: here,
    toplevel: await canonical(toplevel),
    ...(commonDir === undefined || commonDir.length === 0
      ? {}
      : { commonDir: await canonical(commonDir) }),
  })
}
