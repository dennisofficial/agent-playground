import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CredentialError, ECredentialFailure } from '../../credentials/credential-error'
import { SecretCipher } from '../../credentials/secret-cipher'
import { FileSecretsStore } from '../file-secrets-store'

const KEY = 'tvly-dev-abcd1234'

let directory: string

const storeAt = () =>
  new FileSecretsStore({
    file: join(directory, 'secrets.json'),
    cipher: new SecretCipher(join(directory, 'key')),
  })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'atlas-secrets-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the secrets store', () => {
  it('reads back what it wrote', () => {
    const store = storeAt()
    store.write({ name: 'search.tavily', value: KEY })

    expect(store.read('search.tavily')).toBe(KEY)
  })

  it('is empty before anything is written, and after a name is removed', () => {
    const store = storeAt()
    expect(store.read('search.tavily')).toBeUndefined()

    store.write({ name: 'search.tavily', value: KEY })
    store.remove('search.tavily')
    expect(store.read('search.tavily')).toBeUndefined()
  })

  it('survives a fresh store over the same file, which is the next launch', () => {
    storeAt().write({ name: 'search.exa', value: KEY })

    expect(storeAt().read('search.exa')).toBe(KEY)
  })

  it('keeps the other names when one is written or removed', () => {
    const store = storeAt()
    store.write({ name: 'search.tavily', value: 'one' })
    store.write({ name: 'search.exa', value: 'two' })
    store.remove('search.tavily')

    expect(store.read('search.exa')).toBe('two')
  })

  it('never leaves the secret on disk in the clear', () => {
    const file = join(directory, 'secrets.json')
    storeAt().write({ name: 'search.tavily', value: KEY })

    expect(readFileSync(file, 'utf8')).not.toContain(KEY)
  })

  it('writes the file readable only by its owner', () => {
    const file = join(directory, 'secrets.json')
    storeAt().write({ name: 'search.tavily', value: KEY })

    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('names the file when it holds something that is not a secrets file', () => {
    const file = join(directory, 'secrets.json')
    writeFileSync(file, '{"version":9,"secrets":{}}')

    expect(() => storeAt().read('search.tavily')).toThrow(CredentialError)
    try {
      storeAt().read('search.tavily')
    } catch (thrown) {
      expect((thrown as CredentialError).failure).toBe(ECredentialFailure.Unreadable)
      expect((thrown as CredentialError).message).toContain(file)
    }
  })

  it('reports where it writes, so the settings page can say so', () => {
    expect(storeAt().origin()).toBe(join(directory, 'secrets.json'))
  })
})
