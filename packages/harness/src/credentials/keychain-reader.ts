import { CredentialError, ECredentialFailure } from './credential-error'

export interface KeychainReader {
  readGenericPassword(args: { service: string }): Promise<string>
}

const keychainUnavailable = (): CredentialError =>
  new CredentialError({
    failure: ECredentialFailure.StoreUnavailable,
    message: `The macOS Keychain credential backend needs macOS, and this is ${process.platform}. Bind a file-based backend instead.`,
  })

const credentialNotFound = (service: string): CredentialError =>
  new CredentialError({
    failure: ECredentialFailure.NotFound,
    message: `No credential could be read from the macOS Keychain under "${service}". Run \`claude\` once to sign in, and allow keychain access if macOS asks.`,
  })

export const createSecurityKeychainReader = (): KeychainReader => ({
  async readGenericPassword({ service }) {
    if (process.platform !== 'darwin') throw keychainUnavailable()

    const security = Bun.spawn(['security', 'find-generic-password', '-s', service, '-w'], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    })

    const payload = (await new Response(security.stdout).text()).trim()
    const exitCode = await security.exited

    if (exitCode !== 0 || payload.length === 0) throw credentialNotFound(service)

    return payload
  },
})
