import { Box, Text } from 'ink';
import { renderMarkdown } from '../markdown.js';
import type { RenderItem } from './messages.js';

/** One finalized transcript row, rendered by kind. Assistant text is terminal markdown. */
export function MessageView({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case 'user':
      // Same shape as a bot message (name header + body below), just cyan instead of green — so the
      // transcript reads as one uniform stream of "speaker: message" and is easy to skim.
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color="cyan" bold>
              {item.speaker ?? 'You'}
            </Text>
            {item.ts && <Text dimColor>{`  ${item.ts}`}</Text>}
          </Box>
          <Text>{item.text}</Text>
        </Box>
      );

    case 'tool':
      return (
        <Box>
          <Text color="yellow" dimColor>
            {`  ⚙ ${item.speaker ? `${item.speaker}: ` : ''}${item.toolName}`}
          </Text>
        </Box>
      );

    case 'reaction':
      return (
        <Box>
          <Text dimColor>{`   ↳ ${item.by} reacted ${item.emoji}`}</Text>
        </Box>
      );

    // Debug only: the pre-LLM fetch — what the bot walked in knowing, dim blue, indented.
    case 'recall':
      return (
        <Box flexDirection="column">
          <Text color="blue" dimColor>
            {`   ↳ ${item.by} recalled:`}
          </Text>
          <Text color="blue" dimColor>
            {item.text
              .split('\n')
              .map((l) => `      ${l}`)
              .join('\n')}
          </Text>
        </Box>
      );

    // Debug only: the gate's verdict + reasoning, dim magenta so it's clearly meta and skimmable.
    case 'gate':
      return (
        <Box>
          <Text color="magenta" dimColor>
            {`   ▸ gate · ${item.by} → ${item.action}: ${item.reasoning}`}
          </Text>
        </Box>
      );

    // CLI-local output (e.g. the /tasks board) — dim, set off from the chat stream.
    case 'note':
      return (
        <Box marginY={1} paddingLeft={1}>
          <Text dimColor>{item.text}</Text>
        </Box>
      );

    case 'error':
      return (
        <Box marginBottom={1}>
          <Text color="red">{`⚠ ${item.text}`}</Text>
        </Box>
      );

    case 'assistant':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color="green" bold>
              {item.speaker ?? 'bot'}
            </Text>
            {item.ts && <Text dimColor>{`  ${item.ts}`}</Text>}
          </Box>
          <Text>{renderMarkdown(item.text)}</Text>
        </Box>
      );
  }
}
