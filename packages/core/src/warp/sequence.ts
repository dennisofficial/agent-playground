const NOTIFICATION_TEXT_LIMIT = 200

export function truncateForWarpNotification({
  text,
  limit = NOTIFICATION_TEXT_LIMIT,
}: {
  text: string
  limit?: number
}): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 3)}...`
}

// OSC 7 is undocumented for Warp (its docs list only OSC 8/9/52/777/1337) but
// verified: the file tree, branch indicator, PR chip and agent session card
// all follow it. Only % and space are percent-encoded — Warp accepts the rest
// raw. ST-terminated, matching dennisofficial/claude-warp-cwd warp-emit.sh.
export function buildWarpCwdSequence({ cwd, host }: { cwd: string; host: string }): string {
  const encoded = cwd.replaceAll('%', '%25').replaceAll(' ', '%20')
  return `\x1b]7;file://${host}${encoded}\x1b\\`
}

// Plain OSC 777 is Warp's generic notification feature and renders from any
// pane. The structured warp://cli-agent payload form is allowlisted to agent
// names Warp ships (claude, codex, ...), so an unknown agent name is dropped.
export function buildWarpNotificationSequence({
  title,
  body,
}: {
  title: string
  body: string
}): string {
  return `\x1b]777;notify;${sanitizeTitle(title)};${sanitizeBody(body)}\x07`
}

function sanitizeTitle(title: string): string {
  return sanitize(title).replaceAll(';', ':')
}

function sanitizeBody(body: string): string {
  return sanitize(body)
}

function sanitize(text: string): string {
  return text.replaceAll('\x1b', '').replaceAll('\x07', '').replaceAll('\n', ' ')
}
