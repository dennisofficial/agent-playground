import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import React from 'react'

import { registerGrammars } from '../ui/markdown/grammars/index'
import { App } from './app'
import { composeAtlas, type AtlasApp } from './compose'
import { devDatabaseUrl, resolveConfig } from './config'
import { diagnoseCredentialFailure, type CredentialDiagnosis } from './credential-diagnosis'
import { openConversation } from './open-conversation'

const TARGET_FPS = 120

const STILL_RUNNING = 0

async function credentialRefusal(app: AtlasApp): Promise<CredentialDiagnosis | null> {
  try {
    await app.credentials.read()
    return null
  } catch (error) {
    const diagnosis = diagnoseCredentialFailure(error)
    if (diagnosis === null) throw error
    return diagnosis
  }
}

export async function bootAtlas(args: {
  argv: readonly string[]
  env: Record<string, string | undefined>
  cwd: string
}): Promise<number> {
  const config = resolveConfig({ ...args, defaultDatabaseUrl: devDatabaseUrl() })

  const app = await composeAtlas({ config, env: args.env })

  const refused = await credentialRefusal(app)
  if (refused !== null) {
    await app.close()
    process.stderr.write(`${refused.message}\n`)
    return refused.exitCode
  }

  // @opentui/core's first Tree-sitter client takes the default parser set as it finds it, so a
  // grammar registered after the tree mounts never reaches it — and a missing grammar only warns.
  await registerGrammars()

  const opened = await openConversation({
    threads: app.threads,
    log: app.log,
    fresh: config.freshConversation,
  })

  const renderer = await createCliRenderer({
    useMouse: true,
    exitOnCtrlC: false,
    targetFps: TARGET_FPS,
  })

  renderer.on('destroy', () => {
    void app.close().finally(() => process.exit(0))
  })

  createRoot(renderer).render(<App app={app} opened={opened} />)

  return STILL_RUNNING
}
