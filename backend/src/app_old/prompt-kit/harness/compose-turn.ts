import { renderTurn, type TurnChunk } from '@shared/prompt-kit/harness/tag-vocabulary';
import { agentMessage, fromExternal, type AgentMessage } from '@shared/prompt-kit/message';

export type ComposeTurnInput = {
  prefixChunks: TurnChunk[];
  userChunks: TurnChunk[];
};

export function composeTurn(input: ComposeTurnInput): AgentMessage {
  const framedPrefix = renderTurn(input.prefixChunks);
  const body = renderTurn(input.userChunks);
  return agentMessage(framedPrefix ? `${framedPrefix}\n${body}` : body);
}

export function composeSeedTurn(prefixChunks: TurnChunk[], body: AgentMessage): AgentMessage {
  const framedPrefix = renderTurn(prefixChunks);
  return agentMessage(framedPrefix ? `${framedPrefix}\n${body}` : body);
}

export function prependNotice(notice: string, task: AgentMessage): AgentMessage {
  return agentMessage(`${fromExternal(notice)}\n\n${task}`);
}
