import {
  BeforeToolHook,
  DEFAULT_CLASSIFIER_POLICY,
  JudgePort,
  ToolDefinition,
  WorkspaceFactsPort,
} from '@dltech/atlas-core'

import { portToken, resolveSet, type DependencyContainer } from '../container/injection'
import { ClassifierPolicyToken, WorkspaceRoot } from '../container/tokens'
import { ClassifyCallHook, type JudgeSeam } from './classify-call'
import { JudgeMemo } from './judge-memo'

function memoOver({
  resolver,
}: {
  resolver: DependencyContainer
}): { judge: JudgeSeam } | Record<string, never> {
  if (!resolver.isRegistered(portToken(JudgePort), true)) return {}

  return {
    judge: new JudgeMemo({
      judge: resolver.resolve(portToken(JudgePort)),
      policy: resolver.resolve(ClassifierPolicyToken),
    }),
  }
}

export function registerClassifier({ container }: { container: DependencyContainer }): void {
  container.register(ClassifierPolicyToken, { useValue: () => DEFAULT_CLASSIFIER_POLICY })

  container.register(portToken(BeforeToolHook), {
    useFactory: (resolver) =>
      new ClassifyCallHook({
        tools: resolveSet({ container: resolver, token: portToken(ToolDefinition) }),
        facts: resolver.resolve(portToken(WorkspaceFactsPort)),
        launchDirectory: resolver.resolve(WorkspaceRoot),
        policy: resolver.resolve(ClassifierPolicyToken),
        ...memoOver({ resolver }),
      }),
  })
}
