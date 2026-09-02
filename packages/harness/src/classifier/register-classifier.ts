import {
  BeforeToolHook,
  DEFAULT_CLASSIFIER_POLICY,
  JudgePort,
  ToolDefinition,
  WorkspaceFactsPort,
  type ClassifierPolicy,
} from '@dltech/atlas-core'

import { portToken, resolveSet, type DependencyContainer } from '../container/injection'
import { ClassifierPolicyToken, HookMishapReporterToken, WorkspaceRoot } from '../container/tokens'
import { ClassifyCallHook, type JudgeSource } from './classify-call'
import { JudgeMemo } from './judge-memo'

const livePolicy =
  ({ resolver }: { resolver: DependencyContainer }): (() => ClassifierPolicy) =>
  () =>
    resolver.resolve(ClassifierPolicyToken)()

function judgeReachableFrom({ resolver }: { resolver: DependencyContainer }): JudgeSource {
  let memo: JudgeMemo | undefined

  return () => {
    if (!resolver.isRegistered(portToken(JudgePort), true)) return undefined

    memo ??= new JudgeMemo({
      judge: resolver.resolve(portToken(JudgePort)),
      policy: livePolicy({ resolver }),
    })
    return memo
  }
}

const disarmReporterFrom =
  ({ resolver }: { resolver: DependencyContainer }) =>
  (detail: string): void => {
    if (!resolver.isRegistered(HookMishapReporterToken, true)) return

    resolver.resolve(HookMishapReporterToken)({
      label: 'classifyCall',
      kind: 'disarmed',
      detail,
    })
  }

export function registerClassifier({ container }: { container: DependencyContainer }): void {
  container.register(ClassifierPolicyToken, { useValue: () => DEFAULT_CLASSIFIER_POLICY })

  container.register(portToken(BeforeToolHook), {
    useFactory: (resolver) =>
      new ClassifyCallHook({
        tools: resolveSet({ container: resolver, token: portToken(ToolDefinition) }),
        facts: resolver.resolve(portToken(WorkspaceFactsPort)),
        launchDirectory: resolver.resolve(WorkspaceRoot),
        policy: livePolicy({ resolver }),
        judge: judgeReachableFrom({ resolver }),
        reportDisarm: disarmReporterFrom({ resolver }),
      }),
  })
}
