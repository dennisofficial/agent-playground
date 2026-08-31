import { instanceCachingFactory, portToken, type DependencyContainer } from '../container/injection'
import { FileReadStatePort, InMemoryFileReadState } from './read-state'
import { FileWriteGuardPort, VerifyingWriteGuard } from './write-guard'

export function registerFileState({ container }: { container: DependencyContainer }): void {
  container.register(portToken(FileReadStatePort), {
    useFactory: instanceCachingFactory((resolver) => resolver.resolve(InMemoryFileReadState)),
  })
  container.register(portToken(FileWriteGuardPort), {
    useFactory: instanceCachingFactory((resolver) => resolver.resolve(VerifyingWriteGuard)),
  })
}
