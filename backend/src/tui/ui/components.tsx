import { Box, Text } from '../ink';
import { renderMarkdown } from './markdown';
import { formatMessageUsage, type Reaction, type RenderItem } from './messages';

/** Reactions folded onto a message — a single dim row, e.g. `↳ Maya 👍  Sam ✅`. */
const fmtReactions = (rs: Reaction[]): string => `↳ ${rs.map((r) => `${r.by} ${r.emoji}`).join('  ')}`;

/** One transcript row, rendered by kind. Assistant text is terminal markdown.
 * (Ported from playground/src/ui/components.tsx; Ink arrives through the ESM shim.) */
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
          {item.reactions?.length ? <Text dimColor>{`   ${fmtReactions(item.reactions)}`}</Text> : null}
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

    // The human-in-the-loop gate's decision (dormant until the approval flow ports).
    case 'approval':
      return (
        <Box marginY={1}>
          <Text color={item.decision === 'approved' ? 'green' : 'yellow'} bold>
            {`${item.decision === 'approved' ? '✓' : '✕'} ${item.by} ${item.decision} ${item.jobId}${item.note ? ` — ${item.note}` : ''}`}
          </Text>
        </Box>
      );

    case 'error':
      return (
        <Box marginBottom={1}>
          <Text color="red">{`⚠ ${item.text}`}</Text>
        </Box>
      );

    // Observability nodes — dim, indented, tagged by kind.
    case 'worker':
    case 'memory':
    case 'reminders':
    case 'workspace':
      return (
        <Box>
          <Text dimColor>{`   ▪ ${item.by ? `${item.by} ` : ''}[${item.kind}] ${item.text}`}</Text>
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
          {item.usage && <Text dimColor>{`   ${formatMessageUsage(item.usage)}`}</Text>}
          {item.reactions?.length ? <Text dimColor>{`   ${fmtReactions(item.reactions)}`}</Text> : null}
        </Box>
      );
  }
}
