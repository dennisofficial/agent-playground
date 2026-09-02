import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  choiceValueOf,
  CredentialPort,
  DEFAULT_CLASSIFIER_POLICY,
  DEFAULT_WORKTREE_DIRECTORY,
  environmentFor,
  EClassifierMode,
  ESettingId,
  EWebSearchBackend,
  backendOf,
  EventLogPort,
  toThreadId,
  WorkspaceFactsPort,
  type ClassifierPolicy,
  type CorpusFile,
  type Event,
} from '@dltech/atlas-core'
import {
  atlasDatabaseUrl,
  createAnthropicOauthModel,
  createHarnessContainer,
  createSecurityKeychainReader,
  critiqueConfiguration,
  disposeAll,
  ECritique,
  HaikuJudge,
  JudgeMemo,
  KeychainReaderToken,
  openAtlasDatabase,
  portToken,
  PrismaClientToken,
  probeWorkspace,
  remotesOf,
  replayThread,
  summarise,
  ToolRegistry,
  WebSearchBackendToken,
  WorkspaceRoot,
  WorktreeDirectoryToken,
  type DependencyContainer,
  type ReplayRow,
} from '@dltech/atlas-harness'

import { replayLines } from './classify-report'
import { CLASSIFY_USAGE, EClassifyTask, type ClassifyRequest } from './classify'
import { TITLER_MODEL_ID } from './config'
import { loadSettings } from './settings-binding'

const REFUSED = 1

const OK = 0

export const corpusDirectoryIn = ({ cwd }: { cwd: string }): string =>
  join(cwd, '.scratch', 'auto-classifier', 'corpus')

const NETWORK_NOTICE =
  'this run calls the model over the network; every other classify run is offline.'

const say = (lines: readonly string[]): void => {
  process.stdout.write(`${lines.join('\n')}\n`)
}

const complain = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

type Bench = {
  container: DependencyContainer
  policy: ClassifierPolicy
  projectDirectory: string
  launchDirectory: string
  close: () => Promise<void>
}

async function openBench({
  cwd,
  env,
}: {
  cwd: string
  env: Record<string, string | undefined>
}): Promise<Bench> {
  const container = createHarnessContainer()
  const settled = loadSettings({ env, cwd }).service.snapshot().resolution
  const worktreeDirectory = choiceValueOf({
    resolution: settled,
    id: ESettingId.WorktreeDirectory,
    fallback: DEFAULT_WORKTREE_DIRECTORY,
  })

  container.register(WorkspaceRoot, { useValue: cwd })
  container.register(KeychainReaderToken, { useValue: createSecurityKeychainReader() })
  container.register(WorktreeDirectoryToken, { useValue: () => worktreeDirectory })
  container.register(WebSearchBackendToken, {
    useValue: () =>
      backendOf(
        choiceValueOf({
          resolution: settled,
          id: ESettingId.WebSearchBackend,
          fallback: EWebSearchBackend.DuckDuckGo,
        }),
      ) ?? EWebSearchBackend.DuckDuckGo,
  })

  const database = await openAtlasDatabase({ databaseUrl: atlasDatabaseUrl() })
  container.register(PrismaClientToken, { useValue: database.prisma })

  const workspace = await probeWorkspace({ cwd })

  return {
    container,
    projectDirectory: cwd,
    launchDirectory: workspace.repo ?? cwd,
    policy: {
      ...DEFAULT_CLASSIFIER_POLICY,
      mode: EClassifierMode.Nudge,
      environment: environmentFor({
        projectDirectory: cwd,
        repoRoot: workspace.repo ?? undefined,
        worktreeHome:
          workspace.repo === null ? undefined : `${workspace.repo}/${worktreeDirectory}`,
        remotes: await remotesOf({ cwd }),
      }),
    },
    close: async () => {
      await database.close()
      await disposeAll({ container })
    },
  }
}

const judgeOver = ({ bench }: { bench: Bench }): JudgeMemo =>
  new JudgeMemo({
    judge: new HaikuJudge({
      model: createAnthropicOauthModel({
        credentials: bench.container.resolve(portToken(CredentialPort)),
        modelId: TITLER_MODEL_ID,
      }),
    }),
    policy: () => bench.policy,
  })

function capture({
  directory,
  file,
  contents,
}: {
  directory: string
  file: string
  contents: CorpusFile
}): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, file), `${JSON.stringify(contents, null, 2)}\n`)
}

async function runReplay({
  request,
  bench,
}: {
  request: Extract<ClassifyRequest, { task: EClassifyTask.Replay }>
  bench: Bench
}): Promise<number> {
  const threadId = toThreadId(request.threadId)
  const events: readonly Event[] = await bench.container
    .resolve(portToken(EventLogPort))
    .read({ threadId })

  if (events.length === 0) {
    complain(`no thread ${request.threadId} is recorded in this store.`)
    return REFUSED
  }

  if (request.judge) say([NETWORK_NOTICE])

  const report = await replayThread({
    events,
    threadId,
    projectDirectory: bench.projectDirectory,
    launchDirectory: bench.launchDirectory,
    tools: bench.container.resolve(portToken(ToolRegistry)).declarations(),
    facts: bench.container.resolve(portToken(WorkspaceFactsPort)),
    policy: bench.policy,
    ...(request.judge ? { judge: judgeOver({ bench }) } : {}),
  })

  say(replayLines({ report, summary: summarise({ report }), misses: request.misses }))

  if (request.capture) {
    say(
      captured({
        rows: report.rows,
        threadId: request.threadId,
        directory: corpusDirectoryIn({ cwd: bench.projectDirectory }),
      }),
    )
  }

  return OK
}

function captured({
  rows,
  threadId,
  directory,
}: {
  rows: readonly ReplayRow[]
  threadId: string
  directory: string
}): readonly string[] {
  const written: string[] = []

  for (const row of rows) {
    const evidence = row.evidence
    const judged = row.judged
    if (evidence === undefined || judged === undefined) continue

    const file = `${threadId}-${row.callId}.json`
    capture({ directory, file, contents: { expect: judged.triage, note: judged.reason, evidence } })
    written.push(file)
  }

  if (written.length === 0) return ['', 'nothing survived the pre-filter, so no case was captured.']

  return [
    '',
    `captured ${written.length} case(s) into ${directory}:`,
    ...written.map((file) => `  ${file}`),
  ]
}

async function runCritique({ bench }: { bench: Bench }): Promise<number> {
  say([NETWORK_NOTICE, ''])

  const critique = await critiqueConfiguration({
    model: createAnthropicOauthModel({
      credentials: bench.container.resolve(portToken(CredentialPort)),
      modelId: TITLER_MODEL_ID,
    }),
    policy: bench.policy,
  })

  if (critique.kind === ECritique.Unreachable) {
    complain(`the model could not review the configuration: ${critique.fault}`)
    return REFUSED
  }

  say([critique.text])
  return OK
}

export async function runClassify({
  request,
  cwd,
  env,
}: {
  request: ClassifyRequest
  cwd: string
  env: Record<string, string | undefined>
}): Promise<number> {
  if (request.task === EClassifyTask.Usage) {
    if (request.complaint !== undefined) complain(request.complaint)
    say(CLASSIFY_USAGE)
    return request.complaint === undefined ? OK : REFUSED
  }

  const bench = await openBench({ cwd, env })

  try {
    if (request.task === EClassifyTask.Critique) return await runCritique({ bench })
    return await runReplay({ request, bench })
  } finally {
    await bench.close()
  }
}
