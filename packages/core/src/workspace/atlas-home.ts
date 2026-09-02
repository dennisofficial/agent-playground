export const ATLAS_HOME_ENV = 'ATLAS_HOME'
export const ATLAS_DIRECTORY_NAME = '.atlas'

const SEPARATOR = '/'

const withoutTrailingSeparator = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.length === 0 ? SEPARATOR : trimmed
}

const under = (args: { directory: string; name: string }): string =>
  `${withoutTrailingSeparator(args.directory)}${SEPARATOR}${args.name}`

export function atlasHomeFrom(args: {
  env: Record<string, string | undefined>
  home: string
}): string {
  const named = args.env[ATLAS_HOME_ENV]
  if (named !== undefined && named.length > 0) return withoutTrailingSeparator(named)

  return under({ directory: args.home, name: ATLAS_DIRECTORY_NAME })
}
