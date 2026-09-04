import { createHmac } from 'node:crypto'

export const EXPOSED_PORT_FIRST = 3000
export const EXPOSED_PORT_COUNT = 4

export const EXPOSED_PORT_BLOCK: readonly number[] = Array.from(
  { length: EXPOSED_PORT_COUNT },
  (_, index) => EXPOSED_PORT_FIRST + index,
)

export type PublishedPort = {
  containerPort: number
  hostPort: number
}

export type BoundPort = {
  containerPort: number
  hostPort: number
}

export type PortBinding = {
  HostIp: string
  HostPort: string
}

const HOST_PORT_BASE = 20_000

// macOS hands out ephemeral ports from 49152 up, so derived ports stay under it to avoid
// colliding with the OS's own assignments.
const HOST_PORT_SPAN = 49_152 - HOST_PORT_BASE

export function derivedHostPort(args: { worktree: string; containerPort: number }): number {
  const digest = createHmac('sha256', 'atlas-port-exposure')
    .update(`${args.worktree}\n${args.containerPort}`)
    .digest()
  return HOST_PORT_BASE + (digest.readUInt32BE(0) % HOST_PORT_SPAN)
}

export const portInBlock = (containerPort: number): boolean =>
  containerPort >= EXPOSED_PORT_FIRST && containerPort < EXPOSED_PORT_FIRST + EXPOSED_PORT_COUNT

export function blockRefusal(args: { containerPort: number }): string {
  const last = EXPOSED_PORT_FIRST + EXPOSED_PORT_COUNT - 1
  return `port ${args.containerPort} is outside this sandbox's published block (${EXPOSED_PORT_FIRST}-${last}); Docker can only publish ports when the container is created, so the block is fixed and no port beyond it can be published without recreating the container — have the server listen on one of the block's ports and expose that`
}

const listen = (port: number): Bun.TCPSocketListener =>
  Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })

const hostPortFree = (port: number): boolean => {
  try {
    listen(port).stop(true)
    return true
  } catch {
    return false
  }
}

const ephemeralHostPort = (): number => {
  const listener = listen(0)
  const port = listener.port
  listener.stop(true)
  return port
}

export function publishPlanFor(args: { worktree: string }): readonly PublishedPort[] {
  const claimed = new Set<number>()

  return EXPOSED_PORT_BLOCK.map((containerPort) => {
    const derived = derivedHostPort({ worktree: args.worktree, containerPort })
    const hostPort = claimed.has(derived) || !hostPortFree(derived) ? ephemeralHostPort() : derived
    claimed.add(hostPort)
    return { containerPort, hostPort }
  })
}

export function parseBoundPorts(value: unknown): BoundPort[] {
  if (typeof value !== 'object' || value === null) return []

  const ports: BoundPort[] = []
  for (const [key, bindings] of Object.entries(value)) {
    const containerPort = Number(key.split('/')[0])
    if (!Number.isInteger(containerPort) || !Array.isArray(bindings)) continue

    const first: unknown = bindings[0]
    if (typeof first !== 'object' || first === null) continue

    const hostPort = Number((first as { HostPort?: unknown }).HostPort)
    if (!Number.isInteger(hostPort)) continue

    ports.push({ containerPort, hostPort })
  }
  return ports
}
