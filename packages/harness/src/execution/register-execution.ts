import { FileSystemPort, ProcessPort } from '@dltech/atlas-core'

import { instanceCachingFactory, portToken, type DependencyContainer } from '../container/injection'
import { DockerEngineToken } from '../container/tokens'
import { DockerEngine } from './docker/engine'
import { DEFAULT_DOCKER_SOCKET } from './docker/sandbox'
import { LocalFileSystemPort } from './local-filesystem'
import { LocalProcessPort } from './local-process'

export function registerExecution({ container }: { container: DependencyContainer }): void {
  container.register(portToken(ProcessPort), { useClass: LocalProcessPort })
  container.register(portToken(FileSystemPort), { useClass: LocalFileSystemPort })
  container.register(DockerEngineToken, {
    useFactory: instanceCachingFactory(
      () =>
        new DockerEngine({ socketPath: process.env.ATLAS_DOCKER_SOCKET ?? DEFAULT_DOCKER_SOCKET }),
    ),
  })
}
