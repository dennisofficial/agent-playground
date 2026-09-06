import { describe } from 'bun:test'

import { accessSync, constants } from 'node:fs'

export const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export const dockerUnavailableReason = async (socket: string): Promise<string | undefined> => {
  try {
    accessSync(socket, constants.R_OK | constants.W_OK)
    const response = await fetch('http://localhost/_ping', {
      unix: socket,
      signal: AbortSignal.timeout(3000),
    })
    if (response.ok && (await response.text()).trim() === 'OK') return undefined
    return `Docker ping returned HTTP ${response.status}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export const describeLiveDocker = async (args: {
  socket: string
  what: string
}): Promise<typeof describe | typeof describe.skip> => {
  const reason = await dockerUnavailableReason(args.socket)
  if (reason !== undefined) {
    console.warn(`Skipping ${args.what}: ${args.socket}: ${reason}`)
  }
  return reason === undefined ? describe : describe.skip
}
