import { asLabels, asRecord, asString, raw, request } from './engine-http'
import { consumeDaemonProgress } from './image-pull'

export type ImageSummary = {
  id: string
  labels: Record<string, string>
}

export class DockerImages {
  private readonly socketPath: string

  constructor(args: { socketPath: string }) {
    this.socketPath = args.socketPath
  }

  async listImages(args: { labels: Record<string, string> }): Promise<ImageSummary[]> {
    const filters = JSON.stringify({
      label: Object.entries(args.labels).map(([key, value]) => `${key}=${value}`),
    })
    const body = await request({
      socketPath: this.socketPath,
      method: 'GET',
      path: '/images/json',
      query: { filters },
    })
    if (!Array.isArray(body)) throw new Error('the daemon answered out of shape')

    return body.map((entry) => {
      const record = asRecord(entry)
      return { id: asString(record.Id), labels: asLabels(record.Labels) }
    })
  }

  async removeImage(args: { id: string }): Promise<void> {
    await request({
      socketPath: this.socketPath,
      method: 'DELETE',
      path: `/images/${args.id}`,
      query: { force: '1' },
    })
  }

  async buildImage(args: {
    tag: string
    labels: Record<string, string>
    contextTar: Uint8Array<ArrayBuffer>
  }): Promise<void> {
    const response = await raw({
      socketPath: this.socketPath,
      method: 'POST',
      path: '/build',
      query: { t: args.tag, labels: JSON.stringify(args.labels) },
      tarBody: args.contextTar,
    })
    await consumeDaemonProgress({ response, what: `Building ${args.tag}` })
  }
}
