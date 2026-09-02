export {}

const decoder = new TextDecoder()

type Inbound = {
  id?: string | number
  method?: string
  params?: { name?: string }
}

const answer = (inbound: Inbound): object | undefined => {
  if (inbound.method === 'initialize') {
    return {
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        instructions: 'fixture server instructions',
      },
      id: inbound.id,
    }
  }
  if (inbound.method === 'tools/list') {
    return {
      result: {
        tools: [
          {
            name: 'echo',
            description: 'echo the arguments back',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
        ],
      },
      id: inbound.id,
    }
  }
  if (inbound.method === 'tools/call') {
    if (inbound.params?.name === 'throw') {
      return { error: { code: -32000, message: 'the fixture threw' }, id: inbound.id }
    }
    return {
      result: {
        content: [{ type: 'text', text: JSON.stringify(inbound.params?.name ?? 'unknown') }],
        structuredContent: { ok: true },
        isError: false,
      },
      id: inbound.id,
    }
  }
  return undefined
}

let buffer = ''
for await (const chunk of process.stdin) {
  buffer += decoder.decode(chunk, { stream: true })
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) break
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line.length === 0) continue
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
