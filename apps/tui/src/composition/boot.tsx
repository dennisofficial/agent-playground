import { createCliRenderer, type CliRenderer } from '@opentui/core'
import { createRoot, type Root } from '@opentui/react'
import React from 'react'

import { createBootProgress } from './boot-progress'
import { BootScreen } from './boot-screen'
import { devDatabaseUrl, resolveConfig } from './config'
import { ESession, openSession } from './open-session'

const TARGET_FPS = 120

const STILL_RUNNING = 0

const ABANDONED = 130

const takeDown = (args: { root: Root; renderer: CliRenderer }): void => {
  args.root.unmount()
  args.renderer.destroy()
}

/**
 * The renderer comes up before the harness does, so the curtain is what fills the terminal while
 * the database, the credentials and the grammars are still arriving.
 */
export async function bootAtlas(args: {
  argv: readonly string[]
  env: Record<string, string | undefined>
  cwd: string
}): Promise<number> {
  const config = resolveConfig({ ...args, defaultDatabaseUrl: devDatabaseUrl() })
  const progress = createBootProgress()
  const session = openSession({ config, env: args.env, progress })

  const renderer = await createCliRenderer({
    useMouse: true,
    exitOnCtrlC: false,
    targetFps: TARGET_FPS,
  })

  const root = createRoot(renderer)
  root.render(
    <BootScreen
      session={session}
      progress={progress}
      cwd={config.cwd}
      onAbandon={() => {
        takeDown({ root, renderer })
        process.exit(ABANDONED)
      }}
    />,
  )

  const settled = await session

  if (settled.type === ESession.Failed) {
    takeDown({ root, renderer })
    throw settled.error
  }

  if (settled.type === ESession.Refused) {
    takeDown({ root, renderer })
    process.stderr.write(`${settled.message}\n`)
    return settled.exitCode
  }

  renderer.on('destroy', () => {
    void settled.app.close().finally(() => process.exit(0))
  })

  return STILL_RUNNING
}
