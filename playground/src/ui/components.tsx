import { Box, Text } from 'ink';
import { renderMarkdown } from '../markdown.js';
import { BOT } from '../persona.js';
import type { RenderItem } from './messages.js';

/** One finalized transcript row, rendered by kind. Assistant text is terminal markdown. */
export function MessageView({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <Box>
          <Text color="cyan" bold>
            {item.speaker ? `${item.speaker} ❯ ` : '❯ '}
          </Text>
          <Text>{item.text}</Text>
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

    case 'error':
      return (
        <Box marginBottom={1}>
          <Text color="red">{`⚠ ${item.text}`}</Text>
        </Box>
      );

    case 'assistant':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="green" bold>
            {BOT.name}
          </Text>
          <Text>{renderMarkdown(item.text)}</Text>
        </Box>
      );
  }
}
