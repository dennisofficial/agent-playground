import { appearanceOf, applyAppearance } from '../ui/appearance'
import { registerGrammars } from '../ui/markdown/grammars/index'
import { EBootStep, type BootProgress } from './boot-progress'
import { composeAtlas, type AtlasApp } from './compose'
import type { AtlasConfig } from './config'
import { diagnoseCredentialFailure, type CredentialDiagnosis } from './credential-diagnosis'
import { openConversation, type OpenedConversation } from './open-conversation'

export enum ESession {
  Ready = 'ready',
  Refused = 'refused',
  Failed = 'failed',
}

export type Session =
  | { type: ESession.Ready; app: AtlasApp; opened: OpenedConversation }
  | { type: ESession.Refused; message: string; exitCode: number }
  | { type: ESession.Failed; error: unknown }

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

/**
 * Everything the first frame depends on, resolved before anything is mounted — appearance most of
 * all, because a palette applied from an effect repaints a screen the operator has already read.
 */
async function startSession(args: {
  config: AtlasConfig
  env: Record<string, string | undefined>
  progress: BootProgress
}): Promise<Session> {
  const { config, progress } = args

  progress.report(EBootStep.Composing)
  const app = await composeAtlas({ config, env: args.env })
  applyAppearance(appearanceOf({ resolution: app.settings.snapshot().resolution }))

  progress.report(EBootStep.Authorising)
  const refused = await credentialRefusal(app)
  if (refused !== null) {
    await app.close()
    return { type: ESession.Refused, message: refused.message, exitCode: refused.exitCode }
  }

  // @opentui/core's first Tree-sitter client takes the default parser set as it finds it, so a
  // grammar registered after the tree mounts never reaches it — and a missing grammar only warns.
  progress.report(EBootStep.Highlighting)
  await registerGrammars()

  progress.report(EBootStep.Opening)
  const opened = await openConversation({
    threads: app.threads,
    log: app.log,
    ledger: app.ledger,
    fresh: config.freshConversation,
  })

  progress.report(EBootStep.Ready)
  return { type: ESession.Ready, app, opened }
}

/**
 * Never rejects: the curtain and the boot path both hold this promise, and a rejection racing the
 * renderer's own startup would be reported before either could restore the terminal.
 */
export function openSession(args: {
  config: AtlasConfig
  env: Record<string, string | undefined>
  progress: BootProgress
}): Promise<Session> {
  return startSession(args).catch((error: unknown) => ({ type: ESession.Failed, error }) as const)
}
