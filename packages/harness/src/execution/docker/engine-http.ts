export class EngineRequestFailed extends Error {
  readonly status: number

  constructor(args: { status: number; message: string }) {
    super(args.message)
    this.name = 'EngineRequestFailed'
    this.status = args.status
  }
}

export const daemonMessageOf = (body: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const message = (parsed as { message?: unknown }).message
    return typeof message === 'string' ? message : undefined
  } catch {
    return undefined
  }
}

export const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) throw new Error('the daemon answered out of shape')
  return value as Record<string, unknown>
}

export const asString = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('the daemon answered out of shape')
  return value
}

export const asNumber = (value: unknown): number => {
  if (typeof value !== 'number') throw new Error('the daemon answered out of shape')
  return value
}

export const asLabels = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

export async function raw(args: {
  socketPath: string
  method: string
  path: string
  query?: Record<string, string>
  body?: unknown
  tarBody?: Uint8Array<ArrayBuffer>
}): Promise<Response> {
  const query = new URLSearchParams(args.query).toString()
  const url = `http://localhost${args.path}${query === '' ? '' : `?${query}`}`

  const response = await fetch(url, {
    unix: args.socketPath,
    method: args.method,
    ...(args.tarBody !== undefined
      ? { headers: { 'content-type': 'application/x-tar' }, body: args.tarBody }
      : args.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(args.body) }),
  })
  if (response.ok) return response

  const text = await response.text()
  throw new EngineRequestFailed({
    status: response.status,
    message: daemonMessageOf(text) ?? `${args.method} ${args.path} failed with ${response.status}`,
  })
}

export async function request(args: {
  socketPath: string
  method: string
  path: string
  query?: Record<string, string>
  body?: unknown
}): Promise<unknown> {
  return await raw(args).then(async (response) => {
    const text = await response.text()
    return text === '' ? {} : JSON.parse(text)
  })
}
