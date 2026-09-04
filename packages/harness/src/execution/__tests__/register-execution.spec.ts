import { describe, expect, it } from 'bun:test'

import { FileSystemPort, ProcessPort } from '@dltech/atlas-core'

import { createIsolatedContainer, portToken } from '../../container/injection'
import { DockerEngineToken } from '../../container/tokens'
import { DockerEngine } from '../docker/engine'
import { LocalFileSystemPort } from '../local-filesystem'
import { LocalProcessPort } from '../local-process'
import { registerExecution } from '../register-execution'

const wired = () => {
  const container = createIsolatedContainer()
  registerExecution({ container })
  return container
}

describe('registerExecution', () => {
  it('binds the process port to the local adapter', () => {
    expect(wired().resolve(portToken(ProcessPort))).toBeInstanceOf(LocalProcessPort)
  })

  it('binds the filesystem port to the local adapter', () => {
    expect(wired().resolve(portToken(FileSystemPort))).toBeInstanceOf(LocalFileSystemPort)
  })

  it('registers one shared docker engine for the container', () => {
    const wiredContainer = wired()

    expect(wiredContainer.resolve(DockerEngineToken)).toBeInstanceOf(DockerEngine)
    expect(wiredContainer.resolve(DockerEngineToken)).toBe(wiredContainer.resolve(DockerEngineToken))
  })

  it('lets an isolated container rebind the process port without touching the original', () => {
    class OtherProcesses implements ProcessPort {
      spawn(): never {
        throw new Error('not spawned in this test')
      }
      which(): string | null {
        return null
      }
    }

    const first = wired()
    const second = wired()
    second.register(portToken(ProcessPort), { useClass: OtherProcesses })

    expect(second.resolve(portToken(ProcessPort))).toBeInstanceOf(OtherProcesses)
    expect(first.resolve(portToken(ProcessPort))).toBeInstanceOf(LocalProcessPort)
  })
})
