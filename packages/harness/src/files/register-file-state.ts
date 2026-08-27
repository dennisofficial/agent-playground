import { instanceCachingFactory, portToken, type DependencyContainer } from '../container/injection'
import { FileReadStatePort, InMemoryFileReadState } from './read-state'

export function registerFileState({ container }: { container: DependencyContainer }): void {
  container.register(portToken(FileReadStatePort), {
    useFactory: instanceCachingFactory((resolver) => resolver.resolve(InMemoryFileReadState)),
  })
}
