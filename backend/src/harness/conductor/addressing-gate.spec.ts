import { describe, expect, it, vi } from 'vitest';
import type { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeDefinition } from '../employees/employee.types';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import { AddressingGate } from './addressing-gate';

const atlas = { id: 'atlas', name: 'Atlas' } as EmployeeDefinition;

function make(opts: {
  addressed?: string[];
  broadcast?: boolean;
  modelOut?: string;
  modelThrows?: boolean;
}) {
  const employees = {
    isBroadcast: () => opts.broadcast ?? false,
    addressedBots: () => (opts.addressed ?? []).map((id) => ({ id })),
  } as unknown as EmployeeRegistry;
  const invoke = opts.modelThrows
    ? vi.fn().mockRejectedValue(new Error('boom'))
    : vi.fn().mockResolvedValue({ content: opts.modelOut ?? 'RESPOND' });
  const models = {
    buildGateModel: () => ({ invoke }),
  } as unknown as ChatModelFactory;
  return { gate: new AddressingGate(employees, models), invoke };
}

describe('AddressingGate', () => {
  it('responds to a DM without paying for the model', async () => {
    const { gate, invoke } = make({});
    expect(
      await gate.decide({ bot: atlas, isDm: true, text: 'hey', history: '' }),
    ).toBe('respond');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('responds to a broadcast (hard rule)', async () => {
    const { gate, invoke } = make({ broadcast: true });
    expect(
      await gate.decide({
        bot: atlas,
        isDm: false,
        text: '@here ship it',
        history: '',
      }),
    ).toBe('respond');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('responds when Atlas is addressed (hard rule)', async () => {
    const { gate, invoke } = make({ addressed: ['atlas'] });
    expect(
      await gate.decide({
        bot: atlas,
        isDm: false,
        text: 'atlas, look into X',
        history: '',
      }),
    ).toBe('respond');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('skips an ambiguous message the classifier marks SKIP', async () => {
    const { gate, invoke } = make({ modelOut: 'SKIP' });
    expect(
      await gate.decide({
        bot: atlas,
        isDm: false,
        text: 'haha nice one',
        history: 'Dennis: morning\nPat: morning',
      }),
    ).toBe('skip');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('responds to an ambiguous message the classifier marks RESPOND', async () => {
    const { gate } = make({ modelOut: 'RESPOND' });
    expect(
      await gate.decide({
        bot: atlas,
        isDm: false,
        text: 'can we fix the login bug',
        history: '',
      }),
    ).toBe('respond');
  });

  it('fails OPEN to respond when the classifier errors', async () => {
    const { gate } = make({ modelThrows: true });
    expect(
      await gate.decide({
        bot: atlas,
        isDm: false,
        text: 'hmm',
        history: '',
      }),
    ).toBe('respond');
  });
});
