import { describe, expect, it } from 'bun:test';
import { EHarnessVariant } from '../../domain/message.js';
import { runSlashCommand } from '../commands.js';

/**
 * The bug this covers: the palette only ever filled the composer, so Enter sent `/rotate` to the
 * model as a sentence. Every command in the menu was a suggestion the agent could answer in prose.
 */
function target() {
  const sent: { variant: EHarnessVariant; text: string }[] = [];
  const opened: string[] = [];
  return {
    sent,
    opened,
    onServices: () => opened.push('services'),
    conversation: {
      async sendHarness(args: { variant: EHarnessVariant; text: string }): Promise<void> {
        sent.push(args);
      },
    },
  };
}

describe('runSlashCommand', () => {
  it('runs /rotate as a harness ASK rather than sending it to the agent as text', async () => {
    const { sent, conversation, onServices } = target();

    const ran = await runSlashCommand({ text: '/rotate', conversation, onServices });

    expect(ran).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.variant).toBe(EHarnessVariant.transition);
    // The manual path and the nudged path are the same message, and neither one cuts.
    expect(sent[0]?.text).toContain('`rotate`');
  });

  it('takes /compact there too — the SDK rejects it and nothing else reclaims context', async () => {
    const { sent, conversation, onServices } = target();

    expect(await runSlashCommand({ text: '/compact', conversation, onServices })).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('leaves prose alone, and a command nothing runs yet still reaches the agent', async () => {
    const { sent, conversation, onServices } = target();

    expect(await runSlashCommand({ text: 'rotate the tyres', conversation, onServices })).toBe(false);
    expect(await runSlashCommand({ text: '/doctor', conversation, onServices })).toBe(false);
    expect(sent).toEqual([]);
  });

  // A page, not a message. `/services` opens the human's own view of the job's processes — nothing
  // is sent to the agent, which has `service_list` for the same facts in its own form.
  it('runs /services as a navigation act and sends the agent nothing', async () => {
    const { sent, opened, conversation, onServices } = target();

    expect(await runSlashCommand({ text: '/services', conversation, onServices })).toBe(true);
    expect(opened).toEqual(['services']);
    expect(sent).toEqual([]);
  });
});
