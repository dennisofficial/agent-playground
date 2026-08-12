import { describe, expect, it } from 'bun:test';
import { EHarnessVariant } from '../../domain/message.js';
import { runSlashCommand } from '../commands.js';

/**
 * The bug this covers: the palette only ever filled the composer, so Enter sent `/rotate` to the
 * model as a sentence. Every command in the menu was a suggestion the agent could answer in prose.
 */
function target() {
  const sent: { variant: EHarnessVariant; text: string }[] = [];
  return {
    sent,
    conversation: {
      async sendHarness(args: { variant: EHarnessVariant; text: string }): Promise<void> {
        sent.push(args);
      },
    },
  };
}

describe('runSlashCommand', () => {
  it('runs /rotate as a harness ASK rather than sending it to the agent as text', async () => {
    const { sent, conversation } = target();

    const ran = await runSlashCommand({ text: '/rotate', conversation });

    expect(ran).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.variant).toBe(EHarnessVariant.transition);
    // The manual path and the nudged path are the same message, and neither one cuts.
    expect(sent[0]?.text).toContain('`rotate`');
  });

  it('takes /compact there too — the SDK rejects it and nothing else reclaims context', async () => {
    const { sent, conversation } = target();

    expect(await runSlashCommand({ text: '/compact', conversation })).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('leaves prose alone, and a command nothing runs yet still reaches the agent', async () => {
    const { sent, conversation } = target();

    expect(await runSlashCommand({ text: 'rotate the tyres', conversation })).toBe(false);
    expect(await runSlashCommand({ text: '/doctor', conversation })).toBe(false);
    expect(sent).toEqual([]);
  });
});
