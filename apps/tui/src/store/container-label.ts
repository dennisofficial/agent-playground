import { EImageKind, type ImageRef } from '@dltech/atlas-harness'

const tailOfReference = (reference: string): string => {
  const slash = reference.lastIndexOf('/')
  return slash === -1 ? reference : reference.slice(slash + 1)
}

const dockerfileLabelOf = (path: string): string =>
  path
    .split('/')
    .filter((segment) => segment.length > 0)
    .slice(-2)
    .join('/')

export function imageLabelOf(image: ImageRef): string {
  if (image.kind === EImageKind.Dockerfile) return dockerfileLabelOf(image.path)
  return tailOfReference(image.reference)
}
