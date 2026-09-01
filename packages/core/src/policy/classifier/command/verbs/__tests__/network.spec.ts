import { describe, expect, it } from 'bun:test'

import { EDeed, EDeedRealm } from '../../../deed'
import { oneDeed } from './read-deeds'

const actionOf = (command: string): EDeed => oneDeed({ command }).action

describe('the network verbs', () => {
  it('reads a plain fetch and sends on a body or a writing method', () => {
    expect(actionOf('curl -s https://example.test/x')).toBe(EDeed.ReadOnly)
    expect(actionOf('wget https://example.test/x')).toBe(EDeed.ReadOnly)
    expect(actionOf('curl -X POST https://example.test/x')).toBe(EDeed.SendOutbound)
    expect(actionOf('curl -d @body.json https://example.test/x')).toBe(EDeed.SendOutbound)
  })

  it('names the endpoint the data would leave for', () => {
    const deed = oneDeed({ command: 'curl --json {} https://example.test/hook' })

    expect(deed.targets).toEqual([{ realm: EDeedRealm.Remote, value: 'https://example.test/hook' }])
  })

  it('keeps the gh read verbs quiet and the publishing ones visible', () => {
    expect(actionOf('gh pr view 12')).toBe(EDeed.ReadOnly)
    expect(actionOf('gh pr list')).toBe(EDeed.ReadOnly)
    expect(actionOf('gh run view 44')).toBe(EDeed.ReadOnly)
    expect(actionOf('gh pr create --fill')).toBe(EDeed.SendOutbound)
    expect(actionOf('gh release create v1.0.0')).toBe(EDeed.PublishArtifact)
  })

  it('reads npm publish as publishing an artifact', () => {
    expect(actionOf('npm publish')).toBe(EDeed.PublishArtifact)
    expect(actionOf('docker push registry.test/app')).toBe(EDeed.PublishArtifact)
  })

  it('separates a deploy from its own read forms', () => {
    expect(actionOf('terraform apply -auto-approve')).toBe(EDeed.DeployEnvironment)
    expect(actionOf('terraform plan')).toBe(EDeed.ReadOnly)
    expect(actionOf('vercel deploy --prod')).toBe(EDeed.DeployEnvironment)
    expect(actionOf('vercel ls')).toBe(EDeed.ReadOnly)
    expect(actionOf('wrangler publish')).toBe(EDeed.DeployEnvironment)
    expect(actionOf('flyctl deploy')).toBe(EDeed.DeployEnvironment)
    expect(actionOf('kubectl apply -f deploy.yaml')).toBe(EDeed.DeployEnvironment)
    expect(actionOf('kubectl get pods')).toBe(EDeed.ReadOnly)
  })

  it('separates aws s3 ls from aws s3 rm', () => {
    expect(actionOf('aws s3 ls s3://bucket')).toBe(EDeed.ReadOnly)
    expect(actionOf('aws s3 rm s3://bucket/prefix --recursive')).toBe(EDeed.DeployEnvironment)
  })
})
