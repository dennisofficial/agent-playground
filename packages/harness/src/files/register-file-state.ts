import { instanceCachingFactory, portToken, type DependencyContainer } from '../container/injection'
import { FileReadStatePort, InMemoryFileReadState } from './read-state'
import { FileWriteGuardPort, VerifyingWriteGuard } from './write-guard'

export function registerFileState({ container }: { container: DependencyContainer }): void {
  container.register(portToken(FileReadStatePort), {
    useFactory: instanceCachingFactory(() => new InMemoryFileReadState()),
  })
  container.register(portToken(FileWriteGuardPort), {
    useFactory: instanceCachingFactory(
      (resolver) => new VerifyingWriteGuard(resolver.resolve(portToken(FileReadStatePort))),
    ),
  })
}
