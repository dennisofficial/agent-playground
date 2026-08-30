export const ATLAS_HOME_ENV = 'ATLAS_HOME'
export const ATLAS_DIRECTORY_NAME = '.atlas'
export const ATLAS_DEV_HOME_NAME = '.atlas-home'

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
  sourceRoot: string | null
}): string {
  const named = args.env[ATLAS_HOME_ENV]
  if (named !== undefined && named.length > 0) return withoutTrailingSeparator(named)

  if (args.sourceRoot !== null) {
    return under({ directory: args.sourceRoot, name: ATLAS_DEV_HOME_NAME })
  }

  return under({ directory: args.home, name: ATLAS_DIRECTORY_NAME })
}
