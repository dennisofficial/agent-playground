import type { CliRenderer } from '@opentui/core'

export function copyToClipboard(args: { renderer: CliRenderer; text: string }): boolean {
  if (args.renderer.isOsc52Supported() && args.renderer.copyToClipboardOSC52(args.text)) return true
  if (process.platform !== 'darwin') return false

  try {
    const result = Bun.spawnSync(['pbcopy'], { stdin: Buffer.from(args.text) })
    return result.exitCode === 0
  } catch {
    return false
  }
}
