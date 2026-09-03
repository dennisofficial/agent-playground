export {}

const decoder = new TextDecoder()

const FLOOD = `${'noise\n'.repeat(200_000)}`

type Inbound = {
  id?: string | number
  method?: string
}

const answer = (inbound: Inbound): object | undefined => {
  if (inbound.method === 'initialize') {
    return {
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } },
      id: inbound.id,
    }
  }
  if (inbound.method === 'tools/call') {
    return {
      result: {
        content: [{ type: 'text', text: JSON.stringify('echo') }],
        structuredContent: { ok: true },
        isError: false,
      },
      id: inbound.id,
    }
  }
  return undefined
}

process.stderr.write(FLOOD)

let buffer = ''
for await (const chunk of process.stdin) {
  buffer += decoder.decode(chunk, { stream: true })
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) break
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line.length === 0) continue
    process.stderr.write(FLOOD)
    try {
      const message = JSON.parse(line) as Inbound
      const response = answer(message)
      if (response !== undefined) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...response })}\n`)
      }
    } catch {
      continue
    }
  }
}
