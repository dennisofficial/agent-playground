import {
  BeforeToolHook,
  DEFAULT_CLASSIFIER_POLICY,
  EClassifierMode,
  JudgePort,
  ToolDefinition,
  WorkspaceFactsPort,
  type ClassifierPolicy,
} from '@dltech/atlas-core'

import { portToken, resolveSet, type DependencyContainer } from '../container/injection'
import { ClassifierPolicyToken, WorkspaceRoot } from '../container/tokens'
import { ClassifyCallHook, type JudgeSeam } from './classify-call'
import { JudgeMemo } from './judge-memo'

type ClassifierSeams = { policy: () => ClassifierPolicy; judge?: JudgeSeam | undefined }

const demotedToShadow =
  ({ policy }: { policy: () => ClassifierPolicy }): (() => ClassifierPolicy) =>
  () => {
    const current = policy()
    if (current.mode === EClassifierMode.Off) return current
    return { ...current, mode: EClassifierMode.Shadow }
  }

function seamsFor({ resolver }: { resolver: DependencyContainer }): ClassifierSeams {
  const policy = resolver.resolve(ClassifierPolicyToken)
  if (!resolver.isRegistered(portToken(JudgePort), true)) {
    return { policy: demotedToShadow({ policy }) }
  }

  return {
    policy,
    judge: new JudgeMemo({ judge: resolver.resolve(portToken(JudgePort)), policy }),
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
        ...seamsFor({ resolver }),
      }),
  })
}
