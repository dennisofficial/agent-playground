import { Box, Text } from 'ink';
import { renderMarkdown } from '../markdown.js';

export type Role = 'user' | 'assistant' | 'error';

export interface Turn {
  id: number;
  role: Role;
  text: string;
}

/** One finalized transcript row. Assistant text is rendered as terminal markdown. */
export function MessageView({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <Box>
        <Text color="cyan" bold>
          {'❯ '}
        </Text>
        <Text>{turn.text}</Text>
      </Box>
    );
  }

  if (turn.role === 'error') {
    return (
      <Box marginBottom={1}>
        <Text color="red">{`⚠ ${turn.text}`}</Text>
      </Box>
    );
  }

  return (
    <Box marginBottom={1}>
      <Text>{renderMarkdown(turn.text)}</Text>
    </Box>
  );
}
