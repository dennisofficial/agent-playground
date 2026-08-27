import { portToken, resolveSet, type DependencyContainer } from './injection'

export abstract class Disposable {
  abstract close(): Promise<void>
}

export function registerDisposable(args: {
  container: DependencyContainer
  close: () => Promise<void>
}): void {
  args.container.register(portToken(Disposable), { useValue: { close: args.close } })
}

export async function disposeAll(args: { container: DependencyContainer }): Promise<void> {
  const registered = resolveSet({ container: args.container, token: portToken(Disposable) })

  const failures: unknown[] = []
  for (const disposable of [...registered].reverse()) {
    try {
      await disposable.close()
    } catch (error) {
      failures.push(error)
    }
  }

  if (failures.length > 0) throw new AggregateError(failures, 'teardown failed')
}
