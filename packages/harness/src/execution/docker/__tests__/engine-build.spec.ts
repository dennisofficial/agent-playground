import { expect, it } from 'bun:test'

import { DockerEngine } from '../engine'
import { tarEntries } from '../../image/tar'
import { describeLiveDocker } from './live-docker'

const SOCKET = process.env.ATLAS_DOCKER_SOCKET ?? '/var/run/docker.sock'

const describeDocker = await describeLiveDocker({ socket: SOCKET, what: 'live engine build tests' })

const engine = new DockerEngine({ socketPath: SOCKET })
const LABEL = { 'atlas-dev.spec': 'engine-build' }

const sweep = async (): Promise<void> => {
  for (const image of await engine.images.listImages({ labels: LABEL })) {
    await engine.images.removeImage({ id: image.id })
  }
}

describeDocker('DockerEngine image builds over the unix socket', () => {
  it('builds a tar context, finds the image by its label, and removes it', async () => {
    try {
      const tag = `atlas-dev-engine-build:${process.pid}`
      await engine.images.buildImage({
        tag,
        labels: LABEL,
        contextTar: tarEntries({
          entries: [
            {
              name: 'Dockerfile',
              body: new TextEncoder().encode('FROM scratch\nCOPY marker.txt /marker.txt\n'),
            },
            { name: 'marker.txt', body: new TextEncoder().encode('built\n') },
          ],
        }),
      })

      const found = await engine.images.listImages({ labels: LABEL })
      expect(found).toHaveLength(1)
      expect(found[0]?.labels['atlas-dev.spec']).toBe('engine-build')
    } finally {
      await sweep()
    }
    expect(await engine.images.listImages({ labels: LABEL })).toHaveLength(0)
  })

  it('surfaces the daemon stream error for a context that cannot build', async () => {
    const attempt = engine.images.buildImage({
      tag: `atlas-dev-engine-build-broken:${process.pid}`,
      labels: LABEL,
      contextTar: tarEntries({
        entries: [
          { name: 'Dockerfile', body: new TextEncoder().encode('NOTAREALINSTRUCTION now\n') },
        ],
      }),
    })

    await expect(attempt).rejects.toThrow(/unknown instruction|did not mean/i)
    await sweep()
  })
})
