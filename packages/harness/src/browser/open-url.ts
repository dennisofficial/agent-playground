import { spawn } from 'node:child_process'

export type UrlOpener = (url: string) => void

export type BrowserLaunch = { command: string; args: readonly string[] }

export function browserLaunch(args: { platform: string; url: string }): BrowserLaunch {
  if (args.platform === 'darwin') return { command: 'open', args: [args.url] }
  if (args.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', args.url] }
  return { command: 'xdg-open', args: [args.url] }
}

export function createUrlOpener(args: { platform?: string } = {}): UrlOpener {
  const platform = args.platform ?? process.platform

  return (url) => {
    const launch = browserLaunch({ platform, url })
    const launched = spawn(launch.command, [...launch.args], { stdio: 'ignore', detached: true })
    launched.on('error', () => undefined)
    launched.unref()
  }
}
