import { describe, expect, it } from 'bun:test';
import { EMessageType } from '../../generated/prisma/enums.js';
import { EHarnessVariant, type Message, type MessagePayload } from '../message.js';
import { retryTarget } from '../retry.js';

let ordinal = 0;

// Generic in the payload so an assertion can compare against `prompt.payload` without widening it
// back to the whole union — the point of half these tests is WHICH payload came back.
function message<P extends MessagePayload>(payload: P): Message & { payload: P } {
  ordinal += 1;
  return {
    id: `m-${ordinal}`,
    threadId: 't-1',
    sessionId: 's-1',
    ordinal,
    payload,
    createdAt: new Date(0),
  };
}

const failure: MessagePayload = {
  type: EMessageType.error,
  title: 'Turn ended: error_during_execution',
  retryable: true,
};

describe('retryTarget', () => {
  it('re-fires the prompt the dead turn was fired from', () => {
    const prompt = message({ type: EMessageType.user, text: 'run the tests' });
    const error = message(failure);
    const target = retryTarget([prompt, error]);
    expect(target?.errorMessageId).toBe(error.id);
    expect(target?.prompt).toEqual(prompt.payload);
  });

  it('reaches back past whatever the turn managed to produce before it died', () => {
    const prompt = message({ type: EMessageType.user, text: 'run the tests' });
    const messages = [
      prompt,
      message({ type: EMessageType.assistant, text: 'on it' }),
      message({ type: EMessageType.tool_call, toolUseId: 't1', name: 'Bash', input: {} }),
      message({ type: EMessageType.tool_result, toolUseId: 't1', ok: true, summary: 'ran', detail: [] }),
      message(failure),
    ];
    expect(retryTarget(messages)?.prompt).toEqual(prompt.payload);
  });

  it('keeps a harness prompt a harness prompt, attachments and all', () => {
    const prompt = message({
      type: EMessageType.harness,
      variant: EHarnessVariant.handoff,
      text: 'here is where the last leg got to',
      attachments: [{ label: 'context/notes.md', lines: 1, bytes: 6, body: 'a note' }],
    });
    expect(retryTarget([prompt, message(failure)])?.prompt).toEqual(prompt.payload);
  });

  it('offers nothing on a transient error — the turn did not end on it', () => {
    const prompt = message({ type: EMessageType.user, text: 'run the tests' });
    const transient = message({ type: EMessageType.error, title: 'API Error: 529' });
    expect(retryTarget([prompt, transient])).toBeNull();
  });

  it('offers nothing once another turn has happened since', () => {
    const messages = [
      message({ type: EMessageType.user, text: 'run the tests' }),
      message(failure),
      message({ type: EMessageType.user, text: 'try again please' }),
      message({ type: EMessageType.assistant, text: 'done' }),
    ];
    expect(retryTarget(messages)).toBeNull();
  });

  it('offers nothing when nothing was ever sent', () => {
    expect(retryTarget([message(failure)])).toBeNull();
    expect(retryTarget([])).toBeNull();
  });
});
