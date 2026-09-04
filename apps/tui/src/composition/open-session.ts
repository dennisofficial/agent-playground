import { existsSync } from 'node:fs'

import {
  DEFAULT_DOCKER_SOCKET,
  DockerEngine,
  listWorktrees,
  sweepSandboxes,
} from '@dltech/atlas-harness'

import { registerGrammars } from '../ui/markdown/grammars/index'
import { ENoticeTone, notify } from '../ui/notice-store'
import { EBootStep, type BootProgress } from './boot-progress'
import { composeAtlas, type AtlasApp } from './compose'
import type { AtlasConfig } from './config'
import { diagnoseCredentialFailure, type CredentialDiagnosis } from './credential-diagnosis'
import { openConversation, type OpenedConversation } from './open-conversation'
import type { SettingsBinding } from './settings-binding'
import { stateOfDirectory, workspaceRefusal } from './workspace-directory'

const REFUSED = 1

export enum ESession {
  Ready = 'ready',
  Refused = 'refused',
  Failed = 'failed',
}

export type Session =
  | {
      type: ESession.Ready
      app: AtlasApp
      opened: OpenedConversation
      credentialNotice: string | null
    }
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

async function sweepOrphanedSandboxes(args: { cwd: string }): Promise<void> {
  const socketPath = process.env.ATLAS_DOCKER_SOCKET ?? DEFAULT_DOCKER_SOCKET
  if (!existsSync(socketPath)) return

  const listing = await listWorktrees({ cwd: args.cwd })
  if (!listing.ok) return

  const removed = await sweepSandboxes({
    engine: new DockerEngine({ socketPath }),
    worktrees: listing.worktrees.map((worktree) => worktree.path),
  })
  if (removed.length === 0) return

  notify({
    key: 'sandbox-sweep',
    tone: ENoticeTone.Info,
    text: `Removed ${removed.length} sandbox ${removed.length === 1 ? 'container' : 'containers'} whose ${removed.length === 1 ? 'worktree is' : 'worktrees are'} gone: ${removed.join(', ')}`,
  })
}

async function startSession(args: {
  config: AtlasConfig
  env: Record<string, string | undefined>
  progress: BootProgress
  settings: SettingsBinding
}): Promise<Session> {
  const { config, progress } = args

  const unusable = workspaceRefusal({
    directory: config.cwd,
    state: stateOfDirectory(config.cwd),
  })
  if (unusable !== null) return { type: ESession.Refused, message: unusable, exitCode: REFUSED }

  void sweepOrphanedSandboxes({ cwd: config.cwd }).catch(() => undefined)

  progress.report(EBootStep.Composing)
  const app = await composeAtlas({ config, env: args.env, settings: args.settings })

  progress.report(EBootStep.Authorising)
  const refused = await credentialRefusal(app)

  // @opentui/core's first Tree-sitter client takes the default parser set as it finds it, so a
  // grammar registered after the tree mounts never reaches it — and a missing grammar only warns.
  progress.report(EBootStep.Highlighting)
  await registerGrammars()

  progress.report(EBootStep.Opening)
  const outcome = await openConversation({
    threads: app.threads,
    log: app.log,
    ledger: app.ledger,
    agents: app.agents,
    ids: app.ids,
    workspace: app.workspace,
    open: config.open,
  })

  if (!outcome.ok) {
    await app.close()
    return { type: ESession.Refused, message: outcome.reason, exitCode: REFUSED }
  }

  progress.report(EBootStep.Ready)
  return {
    type: ESession.Ready,
    app,
    opened: outcome.conversation,
    credentialNotice: refused?.message ?? null,
  }
}

export function openSession(args: {
  config: AtlasConfig
  env: Record<string, string | undefined>
  progress: BootProgress
  settings: SettingsBinding
}): Promise<Session> {
  return startSession(args).catch((error: unknown) => ({ type: ESession.Failed, error }) as const)
}
