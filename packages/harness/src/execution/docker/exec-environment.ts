export const execEnvFor = (args: {
  requested: Record<string, string | undefined>
  imageEnv: readonly string[]
}): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(args.requested)) {
    if (value !== undefined) env[key] = value
  }

  const imageValue = (key: string): string | undefined =>
    args.imageEnv.find((one) => one.startsWith(`${key}=`))?.slice(key.length + 1)

  const imagePath = imageValue('PATH')
  if (env.PATH !== undefined && imagePath !== undefined) env.PATH = imagePath

  for (const key of ['TMPDIR', 'TMP', 'TEMP']) env[key] = imageValue(key) ?? '/tmp'

  for (const key of ['HOME', 'GNUPGHOME', 'SSH_AUTH_SOCK']) {
    const value = imageValue(key)
    if (value !== undefined) env[key] = value
  }

  if (imageValue('GIT_CONFIG_COUNT') !== undefined) {
    const gitConfigVariable = /^GIT_CONFIG_(COUNT|(?:KEY|VALUE)_\d+)$/
    for (const key of Object.keys(env)) {
      if (gitConfigVariable.test(key)) delete env[key]
    }
    for (const entry of args.imageEnv) {
      const separator = entry.indexOf('=')
      if (separator === -1) continue
      const key = entry.slice(0, separator)
      if (gitConfigVariable.test(key)) env[key] = entry.slice(separator + 1)
    }
  }

  return env
}
