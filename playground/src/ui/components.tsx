import { Box, Text } from 'ink';
import { renderMarkdown } from '../markdown.js';
import type { RenderItem } from './messages.js';

/** One finalized transcript row, rendered by kind. Assistant text is terminal markdown. */
export function MessageView({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case 'user':
      // One wrapping Text (ts as a dim prefix), NOT flex-row siblings — otherwise a long message's
      // timestamp floats to the first line's right edge and the wrapping looks broken.
      return (
        <Box>
          <Text>
            {item.ts ? <Text dimColor>{item.ts} </Text> : null}
            <Text color="cyan" bold>
              {item.speaker ? `${item.speaker} ❯ ` : '❯ '}
            </Text>
            {item.text}
          </Text>
        </Box>
      );

    case 'tool':
      return (
        <Box>
          <Text color="yellow" dimColor>
            {`  ⚙ ${item.toolName}`}
          </Text>
        </Box>
      );

    case 'reaction':
      return (
        <Box>
          <Text dimColor>{`   ↳ ${item.by} reacted ${item.emoji}`}</Text>
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
