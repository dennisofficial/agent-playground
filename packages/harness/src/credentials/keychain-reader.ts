import { CredentialError, ECredentialFailure } from './credential-error'

export interface KeychainReader {
  readGenericPassword(args: { service: string }): Promise<string>
  writeGenericPassword(args: { service: string; payload: string }): Promise<void>
}

const keychainUnavailable = (): CredentialError =>
  new CredentialError({
    failure: ECredentialFailure.StoreUnavailable,
    message: `The macOS Keychain credential backend needs macOS, and this is ${process.platform}.`,
  })

const credentialNotFound = (service: string): CredentialError =>
  new CredentialError({
    failure: ECredentialFailure.NotFound,
    message: `No credential could be read from the macOS Keychain under "${service}".`,
  })

const runSecurity = async (
  argv: readonly string[],
): Promise<{ exitCode: number; output: string }> => {
  const security = Bun.spawn(['security', ...argv], {
    stdout: 'pipe',
    stderr: 'ignore',
    stdin: 'ignore',
  })

  const output = (await new Response(security.stdout).text()).trim()

  return { exitCode: await security.exited, output }
}

const ACCOUNT_ATTRIBUTE = /"acct"<blob>="(.*)"/

const accountAttributeOf = (attributes: string): string | undefined =>
  ACCOUNT_ATTRIBUTE.exec(attributes)?.[1]

export const createSecurityKeychainReader = (): KeychainReader => ({
  async readGenericPassword({ service }) {
    if (process.platform !== 'darwin') throw keychainUnavailable()

    const { exitCode, output } = await runSecurity(['find-generic-password', '-s', service, '-w'])
    if (exitCode !== 0 || output.length === 0) throw credentialNotFound(service)

    return output
  },

  // `security add-generic-password` takes the secret as an argument. Its interactive prompt is the
  // only alternative and it reads from the terminal rather than stdin: piping to it stores an empty
  // password and still reports success.
  async writeGenericPassword({ service, payload }) {
    if (process.platform !== 'darwin') throw keychainUnavailable()

    const attributes = await runSecurity(['find-generic-password', '-s', service])
    const account = accountAttributeOf(attributes.output)

    const { exitCode } = await runSecurity([
      'add-generic-password',
      '-U',
      '-s',
      service,
      ...(account === undefined ? [] : ['-a', account]),
      '-w',
      payload,
    ])

    if (exitCode !== 0)
      throw new CredentialError({
        failure: ECredentialFailure.StoreUnavailable,
        message: `The macOS Keychain refused a write under "${service}".`,
      })
  },
})
