import {
  BeforeToolHook,
  DEFAULT_CLASSIFIER_POLICY,
  ToolDefinition,
  WorkspaceFactsPort,
} from '@dltech/atlas-core'

import { portToken, resolveSet, type DependencyContainer } from '../container/injection'
import { ClassifierPolicyToken, WorkspaceRoot } from '../container/tokens'
import { ClassifyCallHook } from './classify-call'

export function registerClassifier({ container }: { container: DependencyContainer }): void {
  container.register(ClassifierPolicyToken, { useValue: () => DEFAULT_CLASSIFIER_POLICY })

  container.register(portToken(BeforeToolHook), {
    useFactory: (resolver) =>
      new ClassifyCallHook({
        tools: resolveSet({ container: resolver, token: portToken(ToolDefinition) }),
        facts: resolver.resolve(portToken(WorkspaceFactsPort)),
        launchDirectory: resolver.resolve(WorkspaceRoot),
        policy: resolver.resolve(ClassifierPolicyToken),
      }),
  })
}
